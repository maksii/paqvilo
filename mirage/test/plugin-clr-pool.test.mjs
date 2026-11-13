// @test-kind contract: Paqvilo CLR host lifecycle: startup probe allowance, explicit pooling opt-in, owned cache cleanup, worker protocol bounds
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker, MessageChannel, MessagePort } from 'node:worker_threads';
import workerThreads from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { DataStore } from '../lib/data.mjs';
import {
  prepareClrRuntime,
  executeClrPlugin,
  clrContext,
  closeClrHostPool,
  clrHostPoolStatus,
  validateClrDescriptor,
  releaseClrRuntime,
  enterPluginExecution,
  leavePluginExecution,
  pluginExecutionDepth,
  PLUGIN_MAX_DEPTH,
} from '../lib/plugin-clr.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const user = '10000000-0000-0000-0000-000000000001',
  rowId = '20000000-0000-0000-0000-000000000001';
// hang guard only: a blocked synchronous child cannot be ended by the test runner
const CLI_HANG_GUARD_MS = 170_000;
// A killed host exits at once, and an orphan host's watcher checks its exact parent every 100 ms (plugin-clr-host.cs).
// Windows gives no exit handle for a process another one started, so absence is polled; the limit bounds only a failing
// run, as a passing run stops polling when the host is gone.
const HOST_EXIT_LIMIT_MS = 30_000;
async function processAbsent(pid, limitMs) {
  for (const deadline = Date.now() + limitMs; Date.now() < deadline; await delay(20))
    try {
      process.kill(pid, 0);
    } catch (cause) {
      if (cause.code === 'ESRCH') return true;
      throw cause;
    }
  return false;
}

test('cold CLR parent identification has a separate bounded startup allowance', { skip: CLR_SKIP }, async (t) => {
  // A wall-clock delay is the behaviour under test: a cold probe slower than the 3-second limit it had before
  // b0420389 must still bind the parent.
  const SLOW_PROBE_MS = 3_500;
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-clr-parent-start-')));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  // Execution snapshots are created beside the runtime directory, so root shows any snapshot left behind.
  const directory = path.join(root, 'runtime');
  await fs.mkdir(directory);
  const source = path.join(directory, 'Protocol.cs'),
    executable = path.join(directory, 'Protocol.exe');
  await fs.writeFile(
    source,
    String.raw`using System;using System.Diagnostics;public static class Protocol{public static void Main(string[] args){
if(args.Length==2&&args[0]=="--process-start"){var mode=Environment.GetEnvironmentVariable("INVENTED_PARENT_MODE");if(mode=="exit")Environment.Exit(73);if(mode=="invalid"){Console.Write("invalid");return;}System.Threading.Thread.Sleep(${SLOW_PROBE_MS});Console.Write(Process.GetProcessById(Int32.Parse(args[1])).StartTime.ToUniversalTime().Ticks);return;}
Console.ReadLine();Console.WriteLine("{\"kind\":\"result\"}");}}`,
  );
  compileClr(source, executable, { target: 'exe' });
  const assembly = path.join(directory, 'Original.dll');
  await fs.writeFile(assembly, 'invented assembly');
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const runtime = {
    directory,
    assembly,
    executable,
    allowedFiles: ['Protocol.cs', 'Protocol.exe', 'Original.dll', 'runtime.json', 'invoke.mjs'],
    files: await Promise.all(
      [assembly, executable].map(async (file) => ({ path: file, sha256: hash(await fs.readFile(file)) })),
    ),
    descriptor: { typeName: 'Invented.Original', timeoutMs: 10000 },
    provenance: { hostSourceSha256: hash(await fs.readFile(new URL('../lib/plugin-clr-host.cs', import.meta.url))) },
  };
  await fs.writeFile(path.join(directory, 'runtime.json'), JSON.stringify(runtime));
  await fs.writeFile(
    path.join(directory, 'invoke.mjs'),
    `import fs from'node:fs';import{executeClrPlugin}from${JSON.stringify(new URL('../lib/plugin-clr.mjs', import.meta.url).href)};
const runtime=JSON.parse(fs.readFileSync(new URL('./runtime.json',import.meta.url)));
const mode=process.env.INVENTED_PARENT_MODE;
try{const result=executeClrPlugin(runtime,{}, {store:{}});if(mode!=='valid')throw Error('Invalid parent probe was admitted');console.log(result.executionMode);}
catch(error){if(mode==='valid'||error.code!=='LocalPluginParentUnavailable')throw error;console.log(error.code);}`,
  );
  for (const mode of ['valid', 'invalid', 'exit']) {
    const result = spawnSync(process.execPath, [path.join(directory, 'invoke.mjs')], {
      env: { ...process.env, INVENTED_PARENT_MODE: mode },
      windowsHide: true,
      encoding: 'utf8',
      timeout: CLI_HANG_GUARD_MS,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
    assert.equal(result.stdout.trim(), mode === 'valid' ? 'fresh-host' : 'LocalPluginParentUnavailable');
    assert.deepEqual(await fs.readdir(root), ['runtime'], 'every execution snapshot is removed');
    assert.deepEqual((await fs.readdir(directory)).sort(), [...runtime.allowedFiles].sort());
  }
});

test('persistent CLR hosts require explicit Boolean opt-in', () => {
  const descriptor = {
    trust: 'execute-local-assembly',
    root: os.tmpdir(),
    sdkRoot: os.tmpdir(),
    cacheRoot: os.tmpdir(),
    assembly: 'Original.dll',
    sdkAssembly: 'Microsoft.Xrm.Sdk.dll',
    typeName: 'Invented.Original',
    serviceProfile: {
      userId: user,
      evidence: 'Invented backend',
      grants: [{ entity: 'widget', operations: ['read'] }],
    },
    context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
  };
  for (const value of ['true', 1, null, {}])
    assert.throws(() => validateClrDescriptor({ ...descriptor, persistentHost: value }), /explicit Boolean/);
  for (const timeoutMs of ['', '1000', null, NaN, Infinity, -Infinity, 0, -1, 100.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateClrDescriptor({ ...descriptor, timeoutMs }), /positive safe integer/);
    assert.throws(
      () => executeClrPlugin({ descriptor: { ...descriptor, timeoutMs } }, {}, { store: {} }),
      /positive safe integer/,
    );
  }
  assert.equal(validateClrDescriptor({ ...descriptor, persistentHost: true }).persistentHost, true);
  assert.deepEqual(clrHostPoolStatus(), []);
});

test('failed CLR preparation removes only its owned cache directory', { skip: CLR_SKIP }, async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-clr-build-failure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  await fs.writeFile(path.join(root, 'Original.dll'), 'invented assembly');
  await fs.writeFile(path.join(root, 'Sdk.dll'), 'invented SDK');
  const cacheRoot = path.join(root, 'cache');
  await fs.mkdir(cacheRoot);
  await fs.writeFile(path.join(cacheRoot, 'keep'), 'unrelated');
  await assert.rejects(
    prepareClrRuntime(
      {
        trust: 'execute-local-assembly',
        root,
        sdkRoot: root,
        cacheRoot,
        assembly: 'Original.dll',
        sdkAssembly: 'Sdk.dll',
        typeName: 'Invented.Original',
        serviceProfile: {
          userId: user,
          evidence: 'Invented backend',
          grants: [{ entity: 'widget', operations: ['read'] }],
        },
        context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
      },
      { compiler: path.join(root, 'missing-compiler.exe') },
    ),
    (error) => error.code === 'LocalPluginClrBuild',
  );
  assert.deepEqual(await fs.readdir(cacheRoot), ['keep']);
});

test(
  'CLR workers reject malformed output and bound a host stalled before dispatch, then kill owned children',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-clr-protocol-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const source = path.join(root, 'Protocol.cs'),
      executable = path.join(root, 'Protocol.exe');
    await fs.writeFile(
      source,
      String.raw`using System;public static class Protocol{public static void Main(){var line=Console.ReadLine();
if(line.Contains("startup-gate")){Console.WriteLine("{\"kind\":\"trace\",\"message\":\"Host waiting before plugin dispatch\"}");Console.ReadLine();Console.WriteLine("{\"kind\":\"result\"}");return;}
if(line.Contains("pending")){Console.WriteLine("{\"kind\":\"rpc\"}");Console.WriteLine("{\"kind\":\"result\"}");}
else if(line.Contains("array"))Console.WriteLine("[]");else Console.WriteLine("null");System.Threading.Thread.Sleep(30000);}}`,
    );
    compileClr(source, executable, { target: 'exe' });
    for (const pooled of [false, true])
      for (const mode of ['null', 'array', 'pending', 'startup-gate', ...(pooled ? ['invalid-timeout'] : [])])
        await t.test(`${pooled ? 'pooled' : 'fresh'} ${mode}`, async (sub) => {
          const { port1, port2 } = new MessageChannel(),
            signal = new SharedArrayBuffer(4),
            input = { mode };
          const worker = new Worker(
            new URL(pooled ? '../lib/plugin-clr-pool-worker.mjs' : '../lib/plugin-clr-worker.mjs', import.meta.url),
            {
              workerData: { port: port2, signal, executable, input, timeout: mode === 'startup-gate' ? 2_000 : 10_000 },
              transferList: [port2],
            },
          );
          const exited = new Promise((resolve) => worker.once('exit', resolve));
          let pid,
            waitingBeforeDispatch = false,
            completed = false;
          sub.after(async () => {
            if (pid)
              try {
                process.kill(pid);
              } catch {
                /* The owned child may already have exited. */
              }
            port1.close();
            // Aborted while still running: terminated. Otherwise the worker ends by itself after its child exits.
            // A failed terminate of an ended worker leaves nothing to stop.
            if (sub.signal.aborted) worker.terminate().catch(() => {});
            await exited;
          });
          // The worker always answers: a protocol failure, or its own timeout failure if the host never writes.
          const failure = await new Promise((resolve, reject) => {
            worker.once('error', reject);
            port1.on('message', (message) => {
              if (message.kind === 'trace' && message.message === 'Host waiting before plugin dispatch')
                waitingBeforeDispatch = true;
              if (message.kind === 'result') completed = true;
              if (message.kind === 'owned-child') {
                pid = message.pid;
                if (mode === 'invalid-timeout')
                  // One millisecond past the native 2-minute sandbox limit.
                  port1.postMessage({ kind: 'invoke', invocationId: 'invented-invocation', input, timeout: 120_001 });
              }
              // A completion after an SDK callback line is legal: the callback came from a plug-in thread.
              if (message.kind === 'failure' || (mode === 'pending' && message.kind === 'result')) resolve(message);
            });
            if (pooled && mode !== 'invalid-timeout')
              port1.postMessage({
                kind: 'invoke',
                invocationId: 'invented-invocation',
                input,
                timeout: mode === 'startup-gate' ? 2_000 : 10_000,
              });
          });
          if (mode === 'pending') assert.equal(failure.kind, 'result');
          else
            assert.equal(
              failure.code,
              mode === 'startup-gate' ? 'LocalPluginTimeout' : 'LocalPluginProtocol',
              failure.message,
            );
          if (mode === 'startup-gate') {
            assert.equal(waitingBeforeDispatch, true, 'the protocol gate precedes plugin dispatch');
            assert.equal(completed, false, 'the gate cannot produce a result without a second input line');
          }
          if (pooled) assert.equal(failure.invocationId, 'invented-invocation');
          assert.ok(pid > 0);
          // Malformed hosts stay alive and the startup gate waits for input the
          // driver never sends, so only the worker's kill makes either absent.
          if (!(pooled && mode === 'pending'))
            assert.equal(await processAbsent(pid, HOST_EXIT_LIMIT_MS), true, 'worker must stop its malformed host');
        });
  },
);

// @test-kind security: pooled hosts are isolated per runtime and a tampered execution snapshot is refused (LocalPluginSourceChanged)
test(
  'pooled process reuse, runtime isolation, snapshot tampering and throwing cleanup diagnostics',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-clr-isolation-')));
    t.after(() => closeClrHostPool());
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const source = path.join(root, 'Protocol.cs'),
      executable = path.join(root, 'Protocol.exe');
    await fs.writeFile(
      source,
      String.raw`using System;using System.Diagnostics;public static class Protocol{public static void Main(string[] args){if(args.Length==2&&args[0]=="--process-start"){Console.Write(Process.GetProcessById(Int32.Parse(args[1])).StartTime.ToUniversalTime().Ticks);return;}while(Console.ReadLine()!=null)Console.WriteLine("{\"kind\":\"result\"}");}}`,
    );
    compileClr(source, executable, { target: 'exe' });
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
    const hostSourceSha256 = hash(await fs.readFile(new URL('../lib/plugin-clr-host.cs', import.meta.url)));
    const makeRuntime = async (name) => {
      const directory = path.join(root, name);
      await fs.mkdir(directory);
      return {
        ...(await stageProtocolFiles(directory, executable)),
        descriptor: { persistentHost: true, typeName: 'Invented.Original', timeoutMs: 10000 },
        provenance: { hostSourceSha256 },
      };
    };
    const first = await makeRuntime('first'),
      second = await makeRuntime('second');
    const invoke = (runtime) => executeClrPlugin(runtime, {}, { store: {} });
    assert.equal(invoke(first).executionMode, 'pooled-fresh-instance');
    const firstPid = clrHostPoolStatus()[0].pid;
    invoke(first);
    assert.equal(clrHostPoolStatus()[0].pid, firstPid);
    invoke(second);
    const secondPid = clrHostPoolStatus().find((host) => host.pid !== firstPid).pid;
    assert.deepEqual(
      closeClrHostPool({
        runtime: first,
        diagnostic: () => {
          throw new Error('Broken diagnostic sink');
        },
      }),
      { closed: 1, allAbsenceVerified: true },
    );
    assert.deepEqual(
      clrHostPoolStatus().map((host) => host.pid),
      [secondPid],
    );
    invoke(second);
    assert.equal(clrHostPoolStatus()[0].pid, secondPid);
    const snapshots = (await fs.readdir(root)).filter((name) => name.startsWith('clr-pool-'));
    assert.equal(snapshots.length, 1, 'closed runtime must remove its execution snapshot despite diagnostic failure');
    await fs.writeFile(path.join(root, snapshots[0], 'Original.dll'), 'changed bytes');
    assert.throws(
      () => invoke(second),
      (error) => error.code === 'LocalPluginSourceChanged',
    );
    assert.deepEqual(clrHostPoolStatus(), []);
    assert.equal((await fs.readdir(root)).filter((name) => name.startsWith('clr-pool-')).length, 0);
    invoke(second);
    assert.equal(clrHostPoolStatus().length, 1, 'tampered host must be replaceable by a verified fresh snapshot');
  },
);

// @test-kind security: only the exact parent incarnation authorizes a CLR host; orphaned hosts terminate after abrupt parent death
test(
  'exact parent incarnation closes fresh and pooled CPU-hung CLR hosts after abrupt Node death',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-clr-parent-death-'))),
      sdk = clrSdk(),
      source = path.join(root, 'Hang.cs'),
      assembly = path.join(root, 'Hang.dll');
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    await fs.writeFile(
      source,
      'using System;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Hang:IPlugin{public void Execute(IServiceProvider p){((ITracingService)p.GetService(typeof(ITracingService))).Trace("entered-cpu-loop");while(true){}}}}',
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Hang.dll',
      typeName: 'Invented.Hang',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: { userId: user, evidence: 'Invented backend', grants: [] },
      context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
      timeoutMs: 10000,
    });
    const born = spawnSync(runtime.executable, ['--process-start', String(process.pid)], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: CLI_HANG_GUARD_MS,
    });
    assert.equal(born.status, 0, born.error?.message);
    assert.match(born.stdout, /^\d+$/);
    const reused = spawnSync(
      runtime.executable,
      ['--parent', String(process.pid), '--parent-start', String(BigInt(born.stdout) + 1n)],
      { windowsHide: true, encoding: 'utf8', timeout: CLI_HANG_GUARD_MS },
    );
    assert.equal(reused.status, 74, 'An existing PID with a different birth time cannot authorize this host.');
    for (const persistentHost of [false, true])
      await t.test(persistentHost ? 'pooled' : 'fresh', async () => {
        const runtimeFile = path.join(root, 'runtime-' + persistentHost + '.json'),
          script = path.join(root, 'parent-' + persistentHost + '.mjs');
        await fs.writeFile(
          runtimeFile,
          JSON.stringify({ ...runtime, descriptor: { ...runtime.descriptor, persistentHost } }),
        );
        await fs.writeFile(
          script,
          `import fs from'node:fs';import http from'node:http';import{executeClrPlugin,clrContext}from${JSON.stringify(new URL('../lib/plugin-clr.mjs', import.meta.url).href)};import{DataStore}from${JSON.stringify(new URL('../lib/data.mjs', import.meta.url).href)};const runtime=JSON.parse(fs.readFileSync(process.argv[2]));const server=http.createServer((q,s)=>s.end('owned'));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));fs.writeSync(1,JSON.stringify({port:server.address().port})+'\\n');const store=new DataStore({state:{mappings:{widget:{idColumn:'widgetid'}},tables:{widget:[]}}}),step={id:'${user}',name:'Invented',images:[]};executeClrPlugin(runtime,clrContext({runtime,store,step,entity:'widget',operation:'create',stage:20,target:{},record:{widgetid:'${rowId}'},frame:{},depth:1}),{store,diagnostic:note=>fs.writeSync(1,JSON.stringify(note)+'\\n')});`,
        );
        const child = spawn(process.execPath, [script, runtimeFile], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let hostPid,
          port,
          buffer = '',
          error = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
          error += chunk;
        });
        try {
          // No wall-clock limit: the child reaches the loop, or exits once its probe (30 s) or plugin (10 s) limit fails.
          await new Promise((resolve, reject) => {
            child.once('exit', (code) => reject(new Error('Invented child exited early: ' + code + ' ' + error)));
            child.stdout.on('data', (chunk) => {
              buffer += chunk;
              for (;;) {
                const end = buffer.indexOf('\n');
                if (end < 0) break;
                const row = JSON.parse(buffer.slice(0, end));
                buffer = buffer.slice(end + 1);
                if (row.port) port = row.port;
                if (row.code === 'PLUGIN_CLR_HOST_STARTED') hostPid = row.pid;
                if (row.code === 'PLUGIN_CLR_TRACE' && row.message === 'entered-cpu-loop') resolve();
              }
            });
          });
          assert.ok(hostPid > 0);
          const exited = new Promise((resolve) => child.once('exit', resolve));
          child.kill('SIGKILL');
          await exited;
          assert.equal(
            await processAbsent(hostPid, HOST_EXIT_LIMIT_MS),
            true,
            'Only the recorded orphan host must terminate, even while plugin code never returns.',
          );
          await assert.rejects(fetch('http://127.0.0.1:' + port));
        } finally {
          child.kill();
          if (hostPid)
            try {
              process.kill(hostPid);
            } catch {
              /* The owned child may already have exited. */
            }
        }
      });
  },
);

test(
  'pooled original DLL gets fresh instance, configuration, context, frame and SDK callbacks; a plug-in failure keeps its host, a timeout closes it',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-clr-pool-')),
      sdk = clrSdk(),
      notes = [];
    t.after(() => {
      closeClrHostPool({ diagnostic: (note) => notes.push(note) });
    });
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'Original.cs'),
      assembly = path.join(root, 'Original.dll');
    await fs.writeFile(
      source,
      `using System;using System.Threading;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Query;
namespace Invented {public sealed class Original:IPlugin {int calls;readonly string config;public Original(string unsecure,string secure){config=unsecure;}
public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var target=(Entity)c.InputParameters["Target"];
if(c.SharedVariables.Contains("leak"))throw new InvalidPluginExecutionException("Frame leaked");c.SharedVariables["leak"]=true;
if(config=="sleep")Thread.Sleep(10000);if(config=="reject")throw new InvalidPluginExecutionException("Configured rejection");
var service=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);
target["observed"]=service.Retrieve("secondary",new Guid("${rowId}"),new ColumnSet("title")).GetAttributeValue<string>("title");
target["instanceCalls"]=++calls;target["configuration"]=config;target["request"]=c.RequestId.ToString();}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Original.dll',
      typeName: 'Invented.Original',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      persistentHost: true,
      serviceProfile: {
        userId: user,
        evidence: 'Invented backend',
        grants: [{ entity: 'secondary', operations: ['read'] }],
      },
      context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
      timeoutMs: 10000,
    });
    const store = new DataStore({
      state: {
        mappings: {
          widget: { idColumn: 'widgetid', entitySet: 'widgets' },
          secondary: { idColumn: 'secondaryid', entitySet: 'secondaries' },
        },
        tables: { widget: [], secondary: [{ secondaryid: rowId, title: 'First' }] },
        settings: { permissionMode: 'enforce' },
      },
    });
    const step = {
      id: user,
      name: 'Invented original',
      entity: 'widget',
      message: 'Create',
      stage: 20,
      rank: 1,
      images: [],
    };
    const invoke = () =>
      executeClrPlugin(
        runtime,
        clrContext({
          runtime,
          store,
          step,
          entity: 'widget',
          operation: 'create',
          stage: 20,
          target: { title: 'Input' },
          record: { widgetid: rowId },
          frame: {},
          depth: 1,
        }),
        { store, diagnostic: (note) => notes.push(note) },
      );
    runtime.descriptor.unsecureConfiguration = 'first';
    const first = invoke();
    assert.equal(first.target.attributes.instanceCalls, 1);
    assert.equal(first.target.attributes.configuration, 'first');
    assert.equal(first.target.attributes.observed, 'First');
    const pid = clrHostPoolStatus()[0].pid;
    assert.ok(pid > 0);
    store.state.tables.secondary[0].title = 'Second';
    runtime.descriptor.unsecureConfiguration = 'second';
    const second = invoke();
    assert.equal(second.target.attributes.instanceCalls, 1);
    assert.equal(second.target.attributes.configuration, 'second');
    assert.equal(second.target.attributes.observed, 'Second');
    assert.notEqual(first.target.attributes.request, second.target.attributes.request);
    assert.equal(clrHostPoolStatus()[0].pid, pid);
    assert.equal(notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STARTED').length, 1);
    runtime.descriptor.unsecureConfiguration = 'reject';
    // A plug-in exception leaves the worker running (native-r2 traceFaults: one domainStamp across faulting requests).
    assert.throws(invoke, /Configured rejection/);
    assert.equal(clrHostPoolStatus()[0].pid, pid);
    runtime.descriptor.unsecureConfiguration = 'after-rejection';
    assert.equal(invoke().target.attributes.configuration, 'after-rejection');
    runtime.descriptor.unsecureConfiguration = 'sleep';
    runtime.descriptor.timeoutMs = 1500;
    assert.throws(invoke, (error) => error.code === 'LocalPluginTimeout');
    assert.deepEqual(clrHostPoolStatus(), []);
    assert.equal(notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STOPPED').at(-1).absenceVerified, true);
    runtime.descriptor.timeoutMs = 10000;
    runtime.descriptor.unsecureConfiguration = 'recovered';
    assert.equal(invoke().target.attributes.observed, 'Second');
    assert.deepEqual(closeClrHostPool({ runtime, diagnostic: (note) => notes.push(note) }), {
      closed: 1,
      allAbsenceVerified: true,
    });
    assert.deepEqual(clrHostPoolStatus(), []);
    assert.equal(
      notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STARTED').length,
      notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STOPPED').length,
    );
  },
);

// @test-kind contract: the pool or fresh worker ends by its own exit once its host exits; never terminated
test('closing a pooled CLR host ends its pool worker by itself, without terminate', { skip: CLR_SKIP }, async (t) => {
  const { terminate, exit } = watchStartedWorkers(t);
  t.after(() => closeClrHostPool());
  const runtime = await protocolRuntime(t, { persistentHost: true });
  assert.equal(executeClrPlugin(runtime, {}, { store: {} }).executionMode, 'pooled-fresh-instance');
  assert.deepEqual(closeClrHostPool(), { closed: 1, allAbsenceVerified: true });
  assert.equal((await exit).code, 0, 'the pool worker ends by its own exit');
  assert.equal(terminate.mock.callCount(), 0, 'terminate is never called on the pool worker');
});

// @test-kind contract: the pool or fresh worker ends by its own exit once its host exits; never terminated
test(
  'a fresh CLR host worker ends by its own exit after its answer, without terminate',
  { skip: CLR_SKIP },
  async (t) => {
    const { terminate, exit } = watchStartedWorkers(t);
    const runtime = await protocolRuntime(t, {});
    assert.equal(executeClrPlugin(runtime, {}, { store: {} }).executionMode, 'fresh-host');
    assert.equal((await exit).code, 0, 'the fresh worker ends by its own exit');
    assert.equal(terminate.mock.callCount(), 0, 'terminate is never called on the fresh worker');
  },
);

test('a fresh CLR host is reported stopped by its own exit', { skip: CLR_SKIP }, async (t) => {
  const notes = [];
  const runtime = await protocolRuntime(t, {});
  const result = executeClrPlugin(runtime, {}, { store: {}, diagnostic: (note) => notes.push(note) });
  assert.equal(result.executionMode, 'fresh-host');
  const stopped = notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STOPPED');
  assert.equal(stopped.length, 1, 'one stop is reported for the one fresh host');
  assert.ok(stopped[0].pid > 0, 'the stopped host is the owned child');
  assert.equal(stopped[0].absenceVerified, true, 'the host exit is reported by its own worker');
});

test(
  'a pooled host that dies before it reads an invocation fails it as a crashed host and is verified stopped',
  { skip: CLR_SKIP },
  async (t) => {
    const post = MessagePort.prototype.postMessage;
    const notes = [];
    let dropped = false;
    t.after(() => closeClrHostPool());
    const runtime = await protocolRuntime(t, { persistentHost: true });
    assert.equal(executeClrPlugin(runtime, {}, { store: {} }).executionMode, 'pooled-fresh-instance');
    const [{ pid }] = clrHostPoolStatus();
    t.mock.method(MessagePort.prototype, 'postMessage', function (message, ...rest) {
      if (!dropped && message.kind === 'invoke') {
        dropped = true;
        process.kill(pid);
        return;
      }
      return post.call(this, message, ...rest);
    });
    assert.throws(
      () => executeClrPlugin(runtime, {}, { store: {}, diagnostic: (note) => notes.push(note) }),
      (error) => error.code === 'LocalPluginHostExited',
    );
    assert.equal(dropped, true, 'the invoke was dropped after the host was killed');
    assert.deepEqual(
      notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STOPPED').map((note) => [note.pid, note.absenceVerified]),
      [[pid, true]],
    );
    assert.deepEqual(clrHostPoolStatus(), []);
  },
);

test(
  'a runtime whose host an earlier close could not verify keeps its cache directory at release',
  { skip: CLR_SKIP },
  async (t) => {
    let pid = 0;
    t.after(() => {
      t.mock.restoreAll();
      if (pid === 0) return;
      try {
        process.kill(pid);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    });
    const runtime = await protocolRuntime(t, { persistentHost: true });
    assert.equal(executeClrPlugin(runtime, {}, { store: {} }).executionMode, 'pooled-fresh-instance');
    const status = clrHostPoolStatus();
    assert.equal(status.length, 1, 'one pooled host is running');
    pid = status[0].pid;
    const post = MessagePort.prototype.postMessage;
    t.mock.method(process, 'kill', () => true);
    t.mock.method(MessagePort.prototype, 'postMessage', function (message, ...rest) {
      if (message.kind === 'cancel') return;
      return post.call(this, message, ...rest);
    });
    const closeNotes = [];
    assert.equal(
      closeClrHostPool({ runtime, hostExitGuardMs: 0, diagnostic: (note) => closeNotes.push(note) }).allAbsenceVerified,
      false,
    );
    assert.deepEqual(
      closeNotes
        .filter((note) => note.code === 'PLUGIN_CLR_HOST_STOPPED')
        .map((note) => [note.pid, note.absenceVerified]),
      [[pid, false]],
    );
    const kept = closeNotes.filter((note) => note.code === 'PLUGIN_CLR_CLEANUP');
    assert.equal(kept.length, 1);
    assert.match(kept[0].message, /^CLR host not verified stopped; snapshot kept: clr-pool-/);
    await assert.doesNotReject(fs.access(path.join(path.dirname(runtime.directory), kept[0].message.split(': ')[1])));
    t.mock.restoreAll();
    process.kill(pid);
    // The system still reports the killed pid, so the release keeps the directory and reports it.
    const kill = process.kill;
    t.mock.method(process, 'kill', (target, signal) =>
      signal === 0 && target === pid ? true : kill.call(process, target, signal),
    );
    const notes = [];
    releaseClrRuntime(runtime, { diagnostic: (note) => notes.push(note) });
    assert.deepEqual(
      notes.map((note) => note.code),
      ['PLUGIN_CLR_CLEANUP'],
      'the kept directory is reported once',
    );
    assert.match(notes[0].message, /^CLR host not verified stopped/);
    // Once the system reports the pid gone, the close is verified and the next release removes nothing kept.
    t.mock.restoreAll();
    t.mock.method(process, 'kill', (target, signal) => {
      if (signal === 0 && target === pid) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return kill.call(process, target, signal);
    });
    assert.deepEqual(closeClrHostPool({ runtime }), { closed: 0, allAbsenceVerified: true });
    const released = [];
    releaseClrRuntime(runtime, { diagnostic: (note) => released.push(note) });
    assert.deepEqual(
      released.filter((note) => note.code === 'PLUGIN_CLR_CLEANUP'),
      [],
      'a gone host no longer keeps the directory',
    );
    // The fixture's runtime directory is not an owned cache directory; the PLUGIN_CLR_CLEANUP note above is the proof.
  },
);

test('a fresh snapshot whose host is not verified stopped is kept and reported', { skip: CLR_SKIP }, async (t) => {
  const runtime = await protocolRuntime(t, {});
  let pid = 0;
  t.after(() => {
    t.mock.restoreAll();
    if (pid === 0) return;
    try {
      process.kill(pid);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  });
  const notes = [];
  const receive = workerThreads.receiveMessageOnPort;
  // The worker kills its host after the answer; hiding its exit report keeps the host unverified on every schedule.
  workerThreads.receiveMessageOnPort = (port) => {
    const packet = receive(port);
    return packet?.message.kind === 'host-process-exited' ? receive(port) : packet;
  };
  syncBuiltinESMExports();
  let result;
  try {
    result = executeClrPlugin(runtime, {}, { store: {}, diagnostic: (note) => notes.push(note), hostExitGuardMs: 0 });
  } finally {
    workerThreads.receiveMessageOnPort = receive;
    syncBuiltinESMExports();
  }
  assert.equal(result.executionMode, 'fresh-host', 'the plug-in answered through the fresh host');
  const stopped = notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STOPPED');
  assert.equal(stopped.length, 1, 'one stop is reported for the one fresh host');
  assert.equal(stopped[0].absenceVerified, false, 'the live host never reported its exit');
  pid = stopped[0].pid;
  const kept = notes.filter((note) => note.code === 'PLUGIN_CLR_CLEANUP');
  assert.equal(kept.length, 1, 'the kept snapshot is reported once');
  const prefix = 'CLR host not verified stopped; snapshot kept: ';
  assert.ok(kept[0].message.startsWith(prefix), kept[0].message);
  const snapshot = path.join(path.dirname(runtime.directory), kept[0].message.slice(prefix.length));
  await assert.doesNotReject(fs.access(snapshot), 'the snapshot stays while its host is not verified');
});

test('a fresh CLR call past the plug-in depth limit starts no host', { skip: CLR_SKIP }, async (t) => {
  const workers = [];
  const onWorker = (worker) => workers.push(worker);
  process.on('worker', onWorker);
  t.after(() => process.off('worker', onWorker));
  const runtime = await protocolRuntime(t, {});
  assert.equal(pluginExecutionDepth(), 0, 'the test starts outside any plug-in execution');
  // A normal fresh call starts one worker, which shows that the worker event is observed in this test.
  assert.equal(executeClrPlugin(runtime, {}, { store: {} }).executionMode, 'fresh-host');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workers.length, 1, 'a normal fresh call starts its host worker');
  workers.splice(0);
  t.after(() => {
    while (pluginExecutionDepth() > 0) leavePluginExecution();
  });
  for (let level = 0; level < PLUGIN_MAX_DEPTH; level++) enterPluginExecution();
  assert.equal(pluginExecutionDepth(), PLUGIN_MAX_DEPTH);
  assert.throws(
    () => executeClrPlugin(runtime, {}, { store: {} }),
    (error) => error.code === 'LocalPluginDepth',
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workers.length, 0, 'no host worker was started');
});

// Every worker a test starts reports 'online' once its thread runs; a worker of an earlier test reported it before.
function watchStartedWorkers(t) {
  const started = new Set(),
    terminate = t.mock.method(Worker.prototype, 'terminate');
  let finish;
  const exit = new Promise((resolve) => {
    finish = resolve;
  });
  const emit = Worker.prototype.emit;
  t.mock.method(Worker.prototype, 'emit', function (name, ...args) {
    if (name === 'online') started.add(this);
    if (name === 'exit' && started.has(this)) finish({ code: args[0] });
    return emit.call(this, name, ...args);
  });
  return { terminate, exit };
}

// Writes an invented assembly and a copy of the protocol host into a folder; returns the runtime fields that list them.
async function stageProtocolFiles(directory, executable) {
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const assembly = path.join(directory, 'Original.dll'),
    host = path.join(directory, 'Protocol.exe');
  await fs.writeFile(assembly, 'invented assembly bytes');
  await fs.copyFile(executable, host);
  const files = await Promise.all(
    [assembly, host].map(async (file) => ({ path: file, sha256: hash(await fs.readFile(file)) })),
  );
  return { directory, assembly, executable: host, files, allowedFiles: files.map((file) => path.basename(file.path)) };
}

// A host that answers every input line with a result and the parent identity probe, compiled from an invented
// source in a fresh folder.
async function protocolRuntime(t, descriptor) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-clr-cycle-')));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const source = path.join(root, 'Protocol.cs'),
    executable = path.join(root, 'Protocol.exe');
  await fs.writeFile(
    source,
    'using System;using System.Diagnostics;public static class Protocol{public static void Main(string[] args){' +
      'if(args.Length==2&&args[0]=="--process-start"){Console.Write(Process.GetProcessById(Int32.Parse(args[1])).StartTime.ToUniversalTime().Ticks);return;}' +
      String.raw`while(Console.ReadLine()!=null)Console.WriteLine("{\"kind\":\"result\"}");}}`,
  );
  compileClr(source, executable, { target: 'exe' });
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const directory = path.join(root, 'runtime');
  await fs.mkdir(directory);
  return {
    ...(await stageProtocolFiles(directory, executable)),
    descriptor: { typeName: 'Invented.Original', timeoutMs: 10000, ...descriptor },
    provenance: { hostSourceSha256: hash(await fs.readFile(new URL('../lib/plugin-clr-host.cs', import.meta.url))) },
  };
}
