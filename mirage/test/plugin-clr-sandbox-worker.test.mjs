// @test-kind parity: native and native-r2 sandbox scenario (both captures): plug-in threads complete SDK calls, the sandbox runs in en-US and UTC, and one worker keeps assembly static state
// The CLR host as the online sandbox worker runs it. Invented C#, schema and identities.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { closeClrHostPool, prepareClrRuntime, sharedClrRuntimePreparer } from '../lib/plugin-clr.mjs';
import { createTraceStore } from '../lib/trace-store.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';

const user = '10000000-0000-4000-8000-000000000301';
const SOURCE = `using System;using System.Diagnostics;using System.Globalization;using System.Threading;using System.Threading.Tasks;using Microsoft.Xrm.Sdk;
namespace Invented{
static class Use{
 public static IPluginExecutionContext Context(IServiceProvider p){return (IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));}
 public static IOrganizationService Service(IServiceProvider p){return ((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(Context(p).UserId);}
 public static Entity Note(string name){var note=new Entity("x_note");note["x_name"]=name;return note;}
 public static string Sandbox(){return CultureInfo.CurrentCulture.Name+"|"+CultureInfo.CurrentUICulture.Name+"|"+TimeZoneInfo.Local.Id+"|"+TimeZoneInfo.Local.GetUtcOffset(DateTime.UtcNow).TotalMinutes+"|"+1234.5m.ToString()+"|"+new DateTime(2026,10,30,10,0,0).ToString();}
}
public sealed class Threads:IPlugin{public void Execute(IServiceProvider p){var s=Use.Service(p);var thread=new Thread(()=>s.Create(Use.Note("thread")));thread.Start();thread.Join();Task.Run(()=>s.Create(Use.Note("task"))).Wait();}}
public sealed class Parallels:IPlugin{public void Execute(IServiceProvider p){var c=Use.Context(p);var s=Use.Service(p);var trace=(ITracingService)p.GetService(typeof(ITracingService));Parallel.For(0,4,i=>s.Create(Use.Note("parallel "+i)));string seen=null;Task.Run(()=>{trace.Trace("from task");seen=c.MessageName;}).Wait();((Entity)c.InputParameters["Target"])["x_name"]=seen;}}
public sealed class NoteDepth:IPlugin{public void Execute(IServiceProvider p){var c=Use.Context(p);((Entity)c.InputParameters["Target"])["x_depth"]=c.Depth;}}
public sealed class Culture:IPlugin{public void Execute(IServiceProvider p){var t=(Entity)Use.Context(p).InputParameters["Target"];t["x_main"]=Use.Sandbox();string thread=null;var worker=new Thread(()=>thread=Use.Sandbox());worker.Start();worker.Join();t["x_thread"]=thread;t["x_task"]=Task.Run(()=>Use.Sandbox()).Result;}}
public sealed class Counter:IPlugin{
 static int constructed;static readonly string stamp=Guid.NewGuid().ToString();int executions;
 public Counter(){Interlocked.Increment(ref constructed);}
 public void Execute(IServiceProvider p){var c=Use.Context(p);var t=(Entity)c.InputParameters["Target"];t["x_constructed"]=constructed;t["x_instance"]=++executions;t["x_stamp"]=stamp;t["x_pid"]=Process.GetCurrentProcess().Id;t["x_depth"]=c.Depth;if(c.MessageName=="Create"&&c.PrimaryEntityName=="x_item")Use.Service(p).Create(Use.Note("nested"));}
}
}`;

let prepared;
const root = fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-sandbox-worker-'));
after(async () => {
  closeClrHostPool();
  await fs.rm(await root, { recursive: true, force: true, maxRetries: 5 });
});
function descriptor(directory, sdk, typeName) {
  return {
    trust: 'execute-local-assembly',
    root: directory,
    assembly: 'Sandbox.dll',
    typeName,
    sdkRoot: path.dirname(sdk),
    sdkAssembly: path.basename(sdk),
    cacheRoot: path.join(directory, 'cache'),
    timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
    serviceProfile: {
      userId: user,
      evidence: 'Invented sandbox worker grants',
      grants: [{ entity: 'x_note', operations: ['create'] }],
    },
    context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
  };
}
async function assembly() {
  prepared ??= (async () => {
    const directory = await root,
      sdk = clrSdk(),
      source = path.join(directory, 'Sandbox.cs');
    await fs.writeFile(source, SOURCE);
    compileClr(source, path.join(directory, 'Sandbox.dll'), { references: [sdk] });
    return { directory, sdk };
  })();
  return prepared;
}
const text = { dataverseType: 'nvarchar' },
  number = { dataverseType: 'int' };
function sandboxStore() {
  const state = emptyState(),
    fields = {
      x_name: text,
      x_main: text,
      x_thread: text,
      x_task: text,
      x_stamp: text,
      x_constructed: number,
      x_instance: number,
      x_pid: number,
      x_depth: number,
    };
  state.mappings.x_item = { entitySet: 'x_items', idColumn: 'x_itemid', fields };
  state.mappings.x_note = { entitySet: 'x_notes', idColumn: 'x_noteid', fields };
  state.tables.x_item = [];
  state.tables.x_note = [];
  return new DataStore({ state });
}
const step = (n, entity, message, typeName) => ({
  id: `30000000-0000-4000-8000-${String(300 + n).padStart(12, '0')}`,
  enabled: true,
  entity,
  message,
  stage: 20,
  rank: 1,
  mode: 0,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName,
  assemblyId: 'invented',
});
// Steps whose descriptors name the same assembly share one prepared runtime and its long-lived host.
async function attach(t, store, steps) {
  const { directory, sdk } = await assembly(),
    prepareRuntime = sharedClrRuntimePreparer(),
    runtimes = new Map();
  for (const item of steps) runtimes.set(item.id, await prepareRuntime(descriptor(directory, sdk, item.typeName)));
  return attachClrSteps(t, {
    store,
    steps,
    runtime: (item) => runtimes.get(item.id),
    prepareRuntime,
  });
}

test(
  'SDK calls from a new Thread and from Task.Run complete as nested Depth 2 operations',
  { skip: CLR_SKIP },
  async (t) => {
    const store = sandboxStore();
    await attach(t, store, [
      step(1, 'x_item', 'Create', 'Invented.Threads'),
      step(2, 'x_note', 'Create', 'Invented.NoteDepth'),
    ]);
    await store.create('x_item', {}, { admin: true });
    assert.deepEqual(
      store.tableRows('x_note').map((note) => [note.x_name, note.x_depth]),
      [
        ['thread', 2],
        ['task', 2],
      ],
    );
  },
);

// @test-kind unproven: Parallel.For callbacks and tracing or reading the context inside Task.Run have no native capture
test(
  'concurrent SDK calls from Parallel.For queue, and a task traces and reads the context',
  { skip: CLR_SKIP },
  async (t) => {
    const store = sandboxStore();
    await attach(t, store, [
      step(3, 'x_item', 'Create', 'Invented.Parallels'),
      step(4, 'x_note', 'Create', 'Invented.NoteDepth'),
    ]);
    store.traces = createTraceStore({ settings: { level: 'summary' } });
    const request = store.traces.start({ kind: 'http', name: 'POST /invented', module: 'portal' });
    const row = await store.traces.run(request, () => store.create('x_item', {}, { admin: true }));
    request.end();
    assert.equal(row.x_name, 'Create');
    assert.deepEqual(
      store
        .tableRows('x_note')
        .map((note) => [note.x_name, note.x_depth])
        .sort(),
      [0, 1, 2, 3].map((i) => ['parallel ' + i, 2]),
    );
    const events = store.traces
      .tree(request.traceId)
      .spans.filter((span) => span.kind === 'plugin-step')
      .flatMap((span) => span.events.filter((event) => event.type === 'trace').map((event) => event.message));
    assert.deepEqual(events, ['from task']);
  },
);

test(
  'the host runs in en-US and UTC on the Execute thread and on threads the plug-in starts',
  { skip: CLR_SKIP },
  async (t) => {
    const store = sandboxStore();
    await attach(t, store, [step(5, 'x_item', 'Create', 'Invented.Culture')]);
    const row = await store.create('x_item', {}, { admin: true });
    // native sandbox body.sandbox: culture/uiCulture en-US, timeZone UTC, utcOffsetMinutes 0, decimalText '1234.5',
    // dateText '10/30/2026 10:00:00 AM'.
    const native = 'en-US|en-US|UTC|0|1234.5|10/30/2026 10:00:00 AM';
    assert.deepEqual([row.x_main, row.x_thread, row.x_task], [native, native, native]);
  },
);

test(
  'one long-lived host keeps assembly static state across steps, messages, depths and requests',
  { skip: CLR_SKIP },
  async (t) => {
    const store = sandboxStore();
    await attach(t, store, [
      step(6, 'x_item', 'Create', 'Invented.Counter'),
      step(7, 'x_item', 'Update', 'Invented.Counter'),
      step(8, 'x_note', 'Create', 'Invented.Counter'),
    ]);
    const created = await store.create('x_item', {}, { admin: true });
    const [nested] = store.tableRows('x_note');
    await store.update('x_item', created.x_itemid, { x_name: 'second request' }, { admin: true });
    const updated = store.tableRows('x_item')[0];
    // native-r2 sandbox: constructedInDomain rises across steps and messages under one domainStamp; native-r2 depth:
    // nested steps run on the Depth 1 process; each execution gets a new instance (instanceExecutions 1).
    assert.deepEqual(
      [created, nested, updated].map((row) => [row.x_constructed, row.x_depth, row.x_instance]),
      [
        [1, 1, 1],
        [2, 2, 1],
        [3, 1, 1],
      ],
    );
    assert.equal(new Set([created, nested, updated].map((row) => row.x_stamp)).size, 1);
    assert.equal(new Set([created, nested, updated].map((row) => row.x_pid)).size, 1);
  },
);

// @test-kind contract: persistentHost false keeps the isolation opt-out (a fresh host per execution)
test(
  'a descriptor opting out with persistentHost false gets a fresh host per execution',
  { skip: CLR_SKIP },
  async (t) => {
    const { directory, sdk } = await assembly(),
      store = sandboxStore(),
      runtime = await prepareClrRuntime({ ...descriptor(directory, sdk, 'Invented.Counter'), persistentHost: false });
    await attachClrSteps(t, { store, steps: [step(9, 'x_note', 'Create', 'Invented.Counter')], runtime });
    const first = await store.create('x_note', {}, { admin: true }),
      second = await store.create('x_note', {}, { admin: true });
    assert.deepEqual([first.x_constructed, second.x_constructed], [1, 1]);
    assert.notEqual(first.x_pid, second.x_pid);
  },
);
