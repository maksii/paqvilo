// @test-kind contract: exported server logic runs in a worker whose cold start and execution budgets are separate, and cannot change local records.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import diagnosticsChannel from 'node:diagnostics_channel';
import { Worker } from 'node:worker_threads';
import { DataStore } from '../lib/data.mjs';
import {
  runExportedServerLogic,
  runExportedCloudFlow,
  importOperationWorkflows,
  assertOperationRole,
  operationHandlers,
} from '../lib/exported-operations.mjs';
import { validatePack } from '../lib/preset-registry.mjs';
import { createSimulator } from '../server.mjs';
import { calledFrom } from './support/timer-origin.mjs';
import { isExactNumeric, stringifyExactJson } from '../lib/exact-numeric.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

// @test-kind security: a flow file that grows during import is refused, so an oversized file is never imported
test('modern flow imports bound the opened file and reject growth during its read', async (t) => {
  const { dir } = await source(t, '');
  const relative = 'modernflows/invented/flow.json',
    file = path.join(dir, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const content = JSON.stringify({
    workflowid: role,
    properties: { definition: { triggers: { manual: { type: 'Request' } }, actions: {} } },
  });
  await fs.writeFile(file, content);
  const layer = { dir, format: 'yaml', files: [{ path: file, relative }] };
  assert.equal((await importOperationWorkflows([layer])).size, 1);
  const read = fsSync.readSync;
  let grew = false;
  t.mock.method(fsSync, 'readSync', (...args) => {
    if (!grew) {
      grew = true;
      fsSync.appendFileSync(file, ' '.repeat(1024 * 1024));
    }
    return read(...args);
  });
  assert.equal((await importOperationWorkflows([layer])).size, 0, 'a changed/oversized flow is never imported');
  assert.equal(grew, true);
});

test('imported flow JSON retains authored unsafe numeric literals before local expression execution', async (t) => {
  const { dir } = await source(t, '');
  await fs.mkdir(path.join(dir, 'Workflows'));
  await fs.writeFile(path.join(dir, 'Workflows/numeric.json.data.xml'), `<Workflow WorkflowId="{${role}}"/>`);
  const raw =
    '{"properties":{"definition":{"triggers":{"manual":{"type":"Request","kind":"powerpages"}},"actions":{"integer":{"type":"Compose","inputs":9007199254740993},"decimal":{"type":"Compose","runAfter":{"integer":["Succeeded"]},"inputs":99999999999.1234567891},"reply":{"type":"Response","kind":"powerpages","runAfter":{"decimal":["Succeeded"]},"inputs":{"statusCode":200,"body":{"integer":"@string(outputs(\'integer\'))","decimal":"@outputs(\'decimal\')"}}}}}}}';
  await fs.writeFile(path.join(dir, 'Workflows/numeric.json'), raw);
  const workflows = await importOperationWorkflows([{ dir }]),
    flow = workflows.get(role);
  assert.equal(flow.definition.properties.definition.actions.integer.inputs.value, '9007199254740993');
  const result = runExportedCloudFlow({ record: { processId: role }, workflows, input: {} });
  assert.equal(result.body.integer, '9007199254740993');
  assert.equal(isExactNumeric(result.body.decimal), true);
  assert.match(stringifyExactJson(result.body), /"decimal":99999999999\.1234567891/);
});

test('exported server connector writes exact raw literals and returns raw-number JSON without internal tags', async (t) => {
  const { record } = await source(
    t,
    "function post(){return Server.Connector.Dataverse.CreateRecord('meters',Server.Context.Body);}function get(){return Server.Connector.Dataverse.RetrieveRecord('meters',Server.Context.QueryParameters.id,'$select=quantity,measure');}",
  );
  const data = new DataStore({
    state: {
      version: 1,
      mappings: {
        meter: {
          entitySet: 'meters',
          idColumn: 'meterid',
          columns: {
            quantity: { type: 'number', dataverseType: 'bigint' },
            measure: { type: 'number', dataverseType: 'decimal', precision: 10 },
          },
        },
      },
      tables: { meter: [] },
      permissions: [{ entity: 'meter', scope: 'global', operations: ['create', 'read'], roles: ['Editor'] }],
      settings: { permissionMode: 'enforce' },
      plugins: [],
    },
  });
  const context = { record, portal: {}, store: data, identity: { id: 'local', roles: ['Editor'] } };
  const created = JSON.parse(
    await runExportedServerLogic({
      ...context,
      method: 'POST',
      body: '{"quantity":9007199254740993,"measure":99999999999.1234567891}',
    }),
  );
  assert.equal(created.StatusCode, 201);
  assert.match(created.Body, /"quantity":9007199254740993/);
  assert.match(created.Body, /"measure":99999999999\.1234567891/);
  assert.doesNotMatch(created.Body, /DataverseNumeric|numericType/);
  const id = JSON.parse(created.Body).meterid;
  assert.equal(data.get('meters', id, context.identity).quantity.value, '9007199254740993');
  const read = JSON.parse(await runExportedServerLogic({ ...context, method: 'GET', query: { id } }));
  assert.equal(read.StatusCode, 200);
  assert.match(read.Body, /"quantity":9007199254740993/);
  assert.match(read.Body, /"measure":99999999999\.1234567891/);
  assert.doesNotMatch(read.Body, /DataverseNumeric|numericType/);
  const forged = JSON.parse(
    await runExportedServerLogic({
      ...context,
      method: 'POST',
      body: '{"quantity":{"$type":"DataverseNumeric","numericType":"Int64","value":"1"}}',
    }),
  );
  assert.equal(forged.StatusCode, 400);
  assert.equal(data.rows('meter', context.identity).length, 1);
});

const role = 'd0000000-0000-4000-8000-000000000001';
async function source(t, code) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-operation-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'logic.js');
  await fs.writeFile(file, code);
  return { dir, record: { name: 'sample', file: await fs.realpath(file), roleIds: [role] } };
}
function store() {
  return new DataStore({
    state: {
      version: 1,
      mappings: { widget: { entitySet: 'widgets', idColumn: 'widgetid' } },
      tables: { widget: [{ widgetid: 'one', title: 'Synthetic' }] },
      permissions: [{ entity: 'widget', scope: 'global', operations: ['read'], roles: ['Reader'] }],
      settings: { permissionMode: 'enforce' },
      plugins: [],
    },
  });
}
// Keeps the first Worker created during the test, the worker of the call under test, as `worker`, and resolves
// `exited` with its exit code. A worker an earlier test started may still be exiting; its 'exit' is not this call's.
function recordWorkerExit(t) {
  const { promise: exited, resolve } = Promise.withResolvers();
  const call = { exited, worker: undefined };
  const created = ({ worker }) => {
    diagnosticsChannel.unsubscribe('worker_threads', created);
    call.worker = worker;
    worker.once('exit', resolve);
  };
  diagnosticsChannel.subscribe('worker_threads', created);
  t.after(() => diagnosticsChannel.unsubscribe('worker_threads', created));
  return call;
}
// Resolves once the host has handled the 'ready' message of the call's worker: the host arms the execution limit then.
function workerReady(t, call) {
  const ready = Promise.withResolvers();
  const emit = Worker.prototype.emit;
  t.mock.method(Worker.prototype, 'emit', function (name, ...args) {
    const handled = emit.call(this, name, ...args);
    if (name === 'message' && this === call.worker && args[0]?.kind === 'ready') ready.resolve();
    return handled;
  });
  return ready.promise;
}
// A failing run must not leave a spinning worker alive: the call's worker is terminated in cleanup only while it still runs.
function terminateLeftRunning(t, call) {
  let running = true;
  call.exited.then(() => {
    running = false;
  });
  t.after(() => {
    if (running) call.worker?.terminate().catch(() => {});
  });
}

// @test-kind security: exported server code reads only what the caller's roles allow and a role-less caller is refused
test('server-logic exported code uses invocation context, local role-scoped reads and connector envelope', async (t) => {
  const { record } = await source(
    t,
    `function post(){ const response=JSON.parse(Server.Connector.Dataverse.RetrieveMultipleRecords('widgets','$select=widgetid,title')); return JSON.stringify({input:JSON.parse(Server.Context.Body),ok:response.IsSuccessStatusCode,rows:JSON.parse(response.Body).value,site:Server.SiteSetting.Get('Sample')}); }`,
  );
  const context = {
    record,
    portal: { settings: { Sample: 'setting' } },
    store: store(),
    identity: { roles: ['Reader'], roleIds: [role] },
    method: 'POST',
    body: '{"count":2}',
  };
  const data = JSON.parse(await runExportedServerLogic(context));
  assert.equal(data.rows[0].title, 'Synthetic');
  assert.equal(data.site, 'setting');
  assert.equal(data.input.count, 2);
  assert.equal(data.ok, true);
  const denied = JSON.parse(await runExportedServerLogic({ ...context, identity: { roles: [] } }));
  assert.equal(denied.ok, false);
  assert.equal(denied.rows, undefined);
  assert.throws(() => assertOperationRole(record, { roleIds: [] }), /web roles/);
  assert.doesNotThrow(() => assertOperationRole(record, { roleIds: [role.toUpperCase()] }));
  assert.throws(() => assertOperationRole({ roleIds: [] }, { roleIds: [role] }), /web roles/);
});

// The delayed Worker bootstrap: longer than the 1000 ms execution budget plus its 300 ms watchdog grace.
const BOOTSTRAP_DELAY_MS = 1500;
// The execution limit the host arms for timeout 1000: the budget plus its 300 ms watchdog grace.
const EXECUTION_LIMIT_MS = 1300;
// hang guard only: a blocked synchronous child cannot be ended by the test runner
const CLI_HANG_GUARD_MS = 170_000;
test('cold server-logic worker startup does not consume the exported-code execution budget', async (t) => {
  const { dir, record } = await source(t, 'function get(){return "Invented ready result";}');
  const preload = path.join(dir, 'preload.mjs');
  await fs.writeFile(
    preload,
    `import {isMainThread} from 'node:worker_threads'; if(!isMainThread) await new Promise(resolve=>setTimeout(resolve,${BOOTSTRAP_DELAY_MS}));`,
  );
  // The child process is the test's own: it records when the host arms the execution limit (whether the worker's
  // 'ready' was already delivered, and how long after the call) and keeps that limit from firing, so the answer and
  // not the speed of the machine after 'ready' decides the result.
  const program = path.join(dir, 'invoke.mjs');
  await fs.writeFile(
    program,
    `import {Worker} from 'node:worker_threads';
import {runExportedServerLogic} from ${JSON.stringify(new URL('../lib/exported-operations.mjs', import.meta.url).href)};
let ready=false;const limits=[];
const emit=Worker.prototype.emit;
Worker.prototype.emit=function(name,...args){if(name==='message'&&args[0]?.kind==='ready')ready=true;return emit.call(this,name,...args);};
const schedule=globalThis.setTimeout;
globalThis.setTimeout=(callback,delay,...rest)=>{if(delay!==${EXECUTION_LIMIT_MS})return schedule(callback,delay,...rest);limits.push({ready,at:performance.now()-started});return schedule(()=>{},0);};
const started=performance.now();
const value=await runExportedServerLogic({record:${JSON.stringify(record)},portal:{},store:{state:{}},timeout:1000});
console.log(JSON.stringify({value,elapsed:performance.now()-started,limits}));`,
  );
  // The preload is inherited by the real Worker: its bootstrap alone exceeds the execution limit.
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, program], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: CLI_HANG_GUARD_MS,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  const answer = JSON.parse(result.stdout);
  assert.equal(answer.value, 'Invented ready result');
  assert.equal(answer.limits.length, 1, `one execution limit is armed: ${JSON.stringify(answer.limits)}`);
  assert.equal(answer.limits[0].ready, true, 'the execution limit is armed only when the worker is ready');
  assert.ok(answer.limits[0].at >= BOOTSTRAP_DELAY_MS, 'the worker bootstrap is not charged to the execution limit');
  assert.ok(answer.elapsed >= BOOTSTRAP_DELAY_MS, 'the execution completed after the delayed worker bootstrap');
});

test('a local run is bounded at 5 s by default, and an explicit timeout sets the bound up to the site limit', async (t) => {
  const { record } = await source(t, 'function get(){return "bounded";}');
  // The site limit (ServerLogic/TimeoutInSeconds) is above the local bound, so the run reports the bound it applies.
  const bound = async (timeout) => {
    const notes = [];
    await runExportedServerLogic({
      record,
      portal: { settings: { 'ServerLogic/TimeoutInSeconds': '120' } },
      store: store(),
      timeout,
      services: { diagnostic: (entry) => notes.push(entry) },
    });
    return notes.filter((note) => note.code === 'SERVER_LOGIC_TIMEOUT_LOCAL').map((note) => note.message);
  };
  assert.deepEqual(await bound(undefined), [
    'ServerLogic/TimeoutInSeconds is 120 s; the local run is bounded at 5000 ms.',
  ]);
  assert.deepEqual(await bound(60_000), [
    'ServerLogic/TimeoutInSeconds is 120 s; the local run is bounded at 60000 ms.',
  ]);
  assert.deepEqual(await bound(600_000), [], 'the bound is the site limit itself');
});

test('a timeout that is not a finite number greater than 0 is refused before the run starts', async (t) => {
  const { record } = await source(t, 'function get(){return "unset";}');
  const run = (timeout) => runExportedServerLogic({ record, portal: {}, store: store(), timeout });
  for (const timeout of [0, -1, Number.NaN, Infinity, '1000', null])
    await assert.rejects(
      run(timeout),
      { name: 'TypeError', message: /^timeout must be a finite number/ },
      String(timeout),
    );
  assert.equal(await run(undefined), 'unset');
});

test('an explicit timeout above the site limit is capped at ServerLogic/TimeoutInSeconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const call = recordWorkerExit(t);
  terminateLeftRunning(t, call);
  const ready = workerReady(t, call);
  // The continuation after the await runs outside the script's own time limit, so only the host limit ends the run.
  const { record } = await source(t, 'async function get(){ await null; for(;;){} }');
  const run = runExportedServerLogic({
    record,
    portal: { settings: { 'ServerLogic/TimeoutInSeconds': '1' } },
    store: store(),
    timeout: 600_000,
  }).then(
    () => 'answered',
    (error) => error,
  );
  await ready;
  t.mock.timers.tick(1300); // the execution limit: the 1 s site limit and its 300 ms grace
  const settled = await Promise.race([run, new Promise((resolve) => setImmediate(() => resolve('still running')))]);
  assert.equal(settled?.code, 'LocalOperationTimeout', String(settled));
  assert.equal(
    settled.message,
    'Server-logic execution exceeded its local time limit of 1000 ms.',
    'the host limit names the capped bound',
  );
  assert.equal(await call.exited, 1, 'the worker stopped at the capped limit is terminated');
});

// @test-kind security: exported server code is stopped at its time limit and a read request cannot delete records
test('exported server code is bounded and read requests cannot change local records', async (t) => {
  const fixture = await source(t, 'function get(){while(true){}}');
  await assert.rejects(
    runExportedServerLogic({ record: fixture.record, portal: {}, store: store(), timeout: 100 }),
    /time|timed out/,
  );
  await assert.rejects(
    runExportedServerLogic({
      record: fixture.record,
      portal: { settings: { 'ServerLogic/TimeoutInSeconds': '0.1' } },
      store: store(),
    }),
    /time|timed out/,
  );
  await fs.writeFile(
    fixture.record.file,
    `function get(){return Server.Connector.Dataverse.DeleteRecord('widgets','one');}`,
  );
  const data = store();
  const denied = JSON.parse(await runExportedServerLogic({ record: fixture.record, portal: {}, store: data }));
  assert.equal(denied.StatusCode, 403);
  assert.equal(data.get('widgets', 'one', { roles: ['Reader'] }).title, 'Synthetic');
  await fs.writeFile(fixture.record.file, 'function get(){return Promise.resolve("async result");}');
  assert.equal(await runExportedServerLogic({ record: fixture.record, portal: {}, store: data }), 'async result');
});

test('an answered server-logic worker exits by itself and is not terminated', async (t) => {
  const { exited } = recordWorkerExit(t);
  const terminate = t.mock.method(Worker.prototype, 'terminate');
  const { record } = await source(t, 'function get(){ return "done"; }');
  const answer = await runExportedServerLogic({
    record,
    portal: {},
    store: store(),
    identity: { roles: ['Reader'] },
  });
  assert.equal(answer, 'done');
  assert.equal(await exited, 0);
  assert.equal(terminate.mock.callCount(), 0);
});

test('an answered server logic has no limit timer left that could terminate its worker', async (t) => {
  // Two workers from outside the call: one exits while the call's exit is held, the other exits after the answer and
  // before the call's worker. Neither exit is the call's.
  const exitOnMessage = 'require("node:worker_threads").parentPort.once("message", () => process.exit(0));';
  const [straggler, outside] = [0, 1].map(() => new Worker(exitOnMessage, { eval: true }));
  for (const worker of [straggler, outside]) t.after(() => worker.terminate());
  await Promise.all([straggler, outside].map((worker) => once(worker, 'online')));
  const call = recordWorkerExit(t);
  const held = Promise.withResolvers();
  let deliver = () => {};
  // A failing run still delivers the held exit, so the call's own exit handling runs.
  t.after(() => deliver());
  const emit = Worker.prototype.emit;
  t.mock.method(Worker.prototype, 'emit', function (name, ...args) {
    if (name === 'exit' && this === call.worker) {
      // Worker removes every listener right after emitting 'exit': keep them to deliver this exit afterwards.
      const listeners = this.listeners('exit');
      deliver = () => {
        deliver = () => {};
        listeners.forEach((listener) => listener.apply(this, args));
      };
      held.resolve();
      return true;
    }
    if (name === 'exit' && this === outside) setImmediate(() => deliver());
    return emit.call(this, name, ...args);
  });
  const product = new URL('../lib/exported-operations.mjs', import.meta.url).href;
  const originalSetTimeout = setTimeout;
  const originalClearTimeout = clearTimeout;
  const armed = [];
  const cleared = [];
  t.mock.method(globalThis, 'setTimeout', (...args) => {
    const handle = originalSetTimeout(...args);
    if (calledFrom(product, import.meta.url)) armed.push(handle);
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', (handle) => {
    cleared.push(handle);
    return originalClearTimeout(handle);
  });
  const terminate = t.mock.method(Worker.prototype, 'terminate');
  const { record } = await source(t, 'function get(){ return "done"; }');
  const answer = await runExportedServerLogic({
    record,
    portal: {},
    store: store(),
    identity: { roles: ['Reader'] },
  });
  assert.equal(answer, 'done');
  await held.promise;
  straggler.postMessage('exit');
  assert.deepEqual(await once(straggler, 'exit'), [0], "another worker's exit is not held back");
  outside.postMessage('exit');
  assert.equal(await call.exited, 0);
  assert.equal(armed.length, 3, 'the call arms its startup limit, its execution limit and its answered-exit guard');
  assert.deepEqual(
    armed.filter((handle) => !cleared.includes(handle)),
    [],
    'every timer armed for the call is cleared once its worker has exited',
  );
  assert.equal(terminate.mock.callCount(), 0);
});

test('an answered worker that keeps running is terminated at the answered-exit guard', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const call = recordWorkerExit(t);
  const terminate = t.mock.method(Worker.prototype, 'terminate');
  terminateLeftRunning(t, call);
  const { record } = await source(
    t,
    'function get(){ (function spin(){ Promise.resolve().then(spin); })(); return "done"; }',
  );
  const answer = await runExportedServerLogic({
    record,
    portal: {},
    store: store(),
    identity: { roles: ['Reader'] },
  });
  assert.equal(answer, 'done');
  assert.equal(terminate.mock.callCount(), 0, 'the answered worker is not terminated before the guard');
  t.mock.timers.tick(30_000);
  assert.equal(terminate.mock.callCount(), 1, 'the answered-exit guard terminates the worker that keeps running');
  assert.equal(await call.exited, 1);
});

test('a limit that falls due while the answer is still queued leaves the call to the answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const call = recordWorkerExit(t);
  const terminate = t.mock.method(Worker.prototype, 'terminate');
  // The worker's result reaches the host only after its limit fell due, as when the main thread is busy past it.
  const held = Promise.withResolvers();
  const emit = Worker.prototype.emit;
  t.mock.method(Worker.prototype, 'emit', function (name, ...args) {
    if (name === 'message' && this === call.worker && args[0]?.kind === 'result') {
      held.resolve(() => emit.call(this, name, ...args));
      return true;
    }
    return emit.call(this, name, ...args);
  });
  const { record } = await source(t, 'function get(){ return "answered in time"; }');
  const run = runExportedServerLogic({ record, portal: {}, store: store(), timeout: 100 });
  const deliver = await held.promise;
  t.mock.timers.tick(400); // the execution limit: the 100 ms bound and its 300 ms grace
  deliver();
  assert.equal(await run, 'answered in time');
  assert.equal(terminate.mock.callCount(), 0, 'a worker that has answered is never terminated at its limit');
  assert.equal(await call.exited, 0);
});

test('a worker that never answers is stopped and terminated at its limit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const call = recordWorkerExit(t);
  const terminate = t.mock.method(Worker.prototype, 'terminate');
  terminateLeftRunning(t, call);
  const ready = workerReady(t, call);
  // The continuation after the await runs outside the script's own time limit, so the worker never answers.
  const { record } = await source(t, 'async function get(){ await null; for(;;){} }');
  const run = runExportedServerLogic({ record, portal: {}, store: store(), timeout: 100 });
  await ready;
  t.mock.timers.tick(400); // the execution limit: the 100 ms bound and its 300 ms grace
  await assert.rejects(run, {
    code: 'LocalOperationTimeout',
    message: 'Server-logic execution exceeded its local time limit of 100 ms.',
  });
  assert.equal(terminate.mock.callCount(), 1);
  assert.equal(await call.exited, 1);
});

test('a server logic that runs past its limit is stopped by its own worker and not terminated', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { exited } = recordWorkerExit(t);
  const terminate = t.mock.method(Worker.prototype, 'terminate');
  const { record } = await source(t, 'function get(){ for(;;){} }');
  await assert.rejects(runExportedServerLogic({ record, portal: {}, store: store(), timeout: 100 }), {
    message: 'Script execution timed out after 100ms',
  });
  assert.equal(await exited, 0);
  assert.equal(terminate.mock.callCount(), 0);
});

// @test-kind security: exported server code cannot create, update or delete without the caller's permission
test('exported server CRUD uses local permissions, projection and the DELETE del convention', async (t) => {
  const fixture = await source(
    t,
    `function post(){return Server.Connector.Dataverse.CreateRecord('widgets',Server.Context.Body);}function put(){return Server.Connector.Dataverse.UpdateRecord('widgets',Server.Context.QueryParameters.id,Server.Context.Body);}function del(){return Server.Connector.Dataverse.DeleteRecord('widgets',Server.Context.QueryParameters.id);}function get(){return Server.Connector.Dataverse.RetrieveRecord('widgets','one','$select=title');}`,
  );
  const data = store();
  const state = data.snapshot();
  state.permissions.push({
    entity: 'widget',
    scope: 'global',
    operations: ['create', 'update', 'delete', 'read'],
    roles: ['Editor'],
  });
  await data.replaceState(state);
  const context = { record: fixture.record, portal: {}, store: data, identity: { id: 'local', roles: ['Editor'] } };
  const created = JSON.parse(await runExportedServerLogic({ ...context, method: 'POST', body: '{"title":"Created"}' }));
  assert.equal(created.StatusCode, 201);
  const id = JSON.parse(created.Body).widgetid;
  assert.ok(id);
  const updated = JSON.parse(
    await runExportedServerLogic({ ...context, method: 'PUT', query: { id }, body: '{"title":"Updated"}' }),
  );
  assert.equal(updated.StatusCode, 204);
  assert.equal(data.get('widgets', id, context.identity).title, 'Updated');
  const selected = JSON.parse(await runExportedServerLogic(context));
  assert.equal(selected.StatusCode, 200);
  assert.equal(JSON.parse(selected.Body).title, 'Synthetic');
  const removed = JSON.parse(await runExportedServerLogic({ ...context, method: 'DELETE', query: { id } }));
  assert.equal(removed.StatusCode, 204);
  assert.equal(data.get('widgets', id, context.identity), null);
  const denied = JSON.parse(
    await runExportedServerLogic({
      ...context,
      identity: { roles: ['Reader'] },
      method: 'POST',
      body: '{"title":"Forbidden"}',
    }),
  );
  assert.equal(denied.StatusCode, 403);
  assert.equal(data.rows('widget', context.identity).length, 1);
});

test('operation registrations are explicit, validated and ambiguous names fail closed', () => {
  assert.equal(operationHandlers().serverLogics.size, 0);
  assert.throws(
    () =>
      operationHandlers([
        { id: 'a', serverLogics: { sample() {} } },
        { id: 'b', serverLogics: { Sample() {} } },
      ]),
    /Ambiguous/,
  );
  const pack = {
    id: 'sample',
    name: 'Synthetic',
    description: 'Synthetic pack',
    matches: () => true,
    presets: () => ({}),
    serverLogics: { sample: 'eval' },
  };
  assert.throws(() => validatePack(pack), /map exported names to functions/);
});

test('flow definition is selected by exported process id and unknown connectors require an explicit action choice', async (t) => {
  const { dir } = await source(t, '');
  await fs.mkdir(path.join(dir, 'Workflows'));
  const definition = {
    properties: {
      definition: {
        triggers: {
          manual: {
            type: 'Request',
            kind: 'powerpages',
            inputs: { schema: { properties: { City: { type: 'string' } }, required: ['City'] } },
          },
        },
        actions: {
          reply: {
            type: 'Response',
            kind: 'powerpages',
            inputs: { statusCode: 200, body: { City: "@triggerBody()?['City']" } },
          },
        },
      },
    },
  };
  await fs.writeFile(path.join(dir, 'Workflows/sample.json'), JSON.stringify(definition));
  await fs.writeFile(path.join(dir, 'Workflows/sample.json.data.xml'), `<Workflow WorkflowId="{${role}}"/>`);
  const workflows = await importOperationWorkflows([{ dir }]);
  const context = { record: { processId: role }, workflows, input: { City: 'London' } };
  assert.deepEqual(runExportedCloudFlow(context), { status: 200, body: { City: 'London' } });
  assert.throws(() => runExportedCloudFlow({ ...context, input: {} }), /required/);
  assert.throws(() => runExportedCloudFlow({ ...context, input: { City: 42 } }), /invalid type/);
  definition.properties.definition.triggers.manual.inputs.schema = {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['count'],
          additionalProperties: false,
          properties: { count: { type: 'integer' }, choice: { enum: ['A', 'B'] } },
        },
      },
    },
  };
  workflows.get(role).definition = definition;
  assert.deepEqual(runExportedCloudFlow({ ...context, input: { items: [{ count: 2, choice: 'A' }] } }).body, {
    City: null,
  });
  assert.throws(() => runExportedCloudFlow({ ...context, input: { items: [{ count: 2.5 }] } }), /invalid type/);
  assert.throws(() => runExportedCloudFlow({ ...context, input: { items: [{}] } }), /required/);
  assert.throws(
    () => runExportedCloudFlow({ ...context, input: { items: [{ count: 2, extra: true }] } }),
    /undeclared/,
  );
  assert.throws(
    () => runExportedCloudFlow({ ...context, input: { items: [{ count: 2, choice: 'C' }] } }),
    /allowed|enum/,
  );
  definition.properties.definition.actions.connector = { type: 'OpenApiConnection' };
  workflows.get(role).definition = definition;
  assert.throws(() => runExportedCloudFlow(context), /explicit action mock or disable/);
  assert.throws(() => runExportedCloudFlow({ ...context, record: { processId: 'missing' } }), /no JSON definition/);
});

// @test-kind security: HTTP operations refuse callers without the exported role or CSRF token
// and never reach the live bridge
test('registered HTTP operations enforce exported roles and CSRF and server logic never uses a live bridge', async (t) => {
  const { dir } = await source(t, '');
  const flow = 'd0000000-0000-4000-8000-000000000002';
  const files = {
    'website.yml': 'adx_websiteid: site\nadx_name: Synthetic Operations',
    'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '<h1>Synthetic</h1>',
    'Runner.webrole.yml': `adx_webroleid: ${role}\nadx_name: Runner`,
    'sample.serverlogic.yml': `adx_serverlogicid: logic\nadx_name: sample\nadx_serverlogic_adx_webrole:\n- ${role}`,
    'sample.js': `function post(){return JSON.stringify({seen:JSON.parse(Server.Context.Body).value});}function get(){return 'ok';}`,
    'Request.cloudflowconsumer.yml': `adx_cloudflowconsumerid: consumer\nadx_name: Sample request\nadx_processid: ${flow}\nadx_flowapiurl: /_api/cloudflow/v1.0/trigger/${flow}\nadx_cloudflowconsumer_adx_webrole:\n- ${role}`,
    'pack.mjs': `export default{id:'synthetic-operations',name:'Synthetic',description:'Invented fixture',matches:()=>true,presets:()=>({}),serverLogics:{sample:({runExportedServerLogic})=>runExportedServerLogic()},cloudFlows:{'Sample request':({input})=>({status:200,body:input})}};`,
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const calls = [],
    liveBridge = {
      origin: 'https://invalid.example',
      configure() {},
      status: () => ({ connected: true }),
      async close() {},
      async request(url) {
        calls.push(url);
        throw new Error('No live request expected');
      },
    };
  const app = await createSimulator({
    sourceDir: dir,
    port: 0,
    watch: false,
    dataPacks: [{ module: path.join(dir, 'pack.mjs') }],
    liveBridge,
    initial: {
      version: 1,
      tables: {},
      mappings: {},
      permissions: [],
      settings: { permissionMode: 'enforce' },
      plugins: [],
      simulator: {
        mode: 'local',
        pageMode: 'local',
        endpoints: [],
        identityScope: 'configured',
        identity: { id: 'person', roles: ['Runner'], roleSource: 'override' },
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  const token = app.csrf;
  const post = (route, headers = {}) =>
    fetch(app.url + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ value: 7 }),
    });
  const logic = '/_api/serverlogics/sample',
    cloud = '/_api/cloudflow/v1.0/trigger/' + flow;
  assert.equal((await post(logic)).status, 403);
  assert.equal((await post(cloud)).status, 403);
  const authorized = { __RequestVerificationToken: token };
  const result = await post(logic, authorized);
  assert.equal(result.status, 200);
  assert.equal(JSON.parse((await result.json()).data).seen, 7);
  const flowResponse = await post(cloud, authorized);
  assert.equal(flowResponse.status, 200);
  assert.deepEqual(await flowResponse.json(), { value: 7 });
  const configure = (body) =>
    fetch(app.url + '/__sim/api/config', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': token },
      body: JSON.stringify(body),
    });
  const switchIdentity = await configure({ identity: { id: 'person', roles: [], roleSource: 'override' } });
  assert.equal(switchIdentity.status, 200, await switchIdentity.text());
  assert.equal((await post(logic, authorized)).status, 403);
  assert.equal((await post(cloud, authorized)).status, 403);
  assert.equal((await configure({ mode: 'live', live: { origin: 'https://invalid.example' } })).status, 200);
  assert.equal((await fetch(app.url + logic)).status, 501);
  assert.deepEqual(calls, []);
});

test('Imported flow HTTP failure retains completed connector commits and Response headers', async (t) => {
  const { dir } = await source(t, ''),
    flow = 'd0000000-0000-4000-8000-000000000003',
    stateFile = path.join(dir, '.paqvilo/state.json');
  const sources = {
    'website.yml': 'adx_websiteid: site\nadx_name: Invented Flow',
    'Request.cloudflowconsumer.yml': `adx_cloudflowconsumerid: consumer\nadx_name: Failure request\nadx_processid: ${flow}\nadx_flowapiurl: /_api/cloudflow/v1.0/trigger/${flow}\nadx_cloudflowconsumer_adx_webrole:\n- ${role}`,
    'Runner.webrole.yml': `adx_webroleid: ${role}\nadx_name: Runner`,
    'pack.mjs': `export default{id:'invented-flow',name:'Invented',description:'Invented',matches:()=>true,presets:()=>({}),flowIdentities:{'${flow}':{userId:'10000000-0000-0000-0000-000000000001',evidence:'Invented backend',grants:[{entity:'widget',operations:['create','read']}]}}};`,
  };
  for (const [file, value] of Object.entries(sources)) await fs.writeFile(path.join(dir, file), value);
  await fs.mkdir(path.join(dir, 'Workflows'));
  const workflow = {
    properties: {
      definition: {
        triggers: { request: { type: 'Request', kind: 'powerpages' } },
        actions: {
          created: {
            type: 'OpenApiConnection',
            inputs: {
              host: { apiId: '/apis/shared_commondataserviceforapps', operationId: 'CreateRecord' },
              parameters: { entityName: 'widgets', 'item/title': 'Committed before later failure' },
            },
          },
          reply: {
            type: 'If',
            runAfter: { created: ['Succeeded'] },
            expression: "@triggerBody()['ok']",
            actions: {
              success: {
                type: 'Response',
                inputs: { headers: { 'x-invented-flow': 'preserved' }, body: "@body('created')" },
              },
            },
            else: {
              actions: {
                failure: {
                  type: 'Terminate',
                  inputs: { runStatus: 'Failed', runError: { message: 'Later action failed' } },
                },
              },
            },
          },
        },
      },
    },
  };
  await fs.writeFile(path.join(dir, 'Workflows/flow.json'), JSON.stringify(workflow));
  await fs.writeFile(
    path.join(dir, 'Workflows/flow.json.data.xml'),
    `<Workflow WorkflowId="${flow}" Name="Invented flow"/>`,
  );
  const app = await createSimulator({
    sourceDir: dir,
    solutionRoots: [dir],
    stateFile,
    port: 0,
    watch: false,
    dataPacks: [{ module: path.join(dir, 'pack.mjs') }],
    initial: {
      version: 1,
      tables: { widget: [] },
      mappings: { widget: { entitySet: 'widgets', idColumn: 'widgetid' } },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        identityScope: 'configured',
        identity: { id: 'caller', roles: ['Runner'], roleSource: 'override' },
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  const send = (ok) =>
    fetch(app.url + '/_api/cloudflow/v1.0/trigger/' + flow, {
      method: 'POST',
      headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf },
      body: JSON.stringify({ ok }),
    });
  const rejected = await send(false);
  assert.equal(rejected.status, 400);
  assert.equal(app.state().data.widget.length, 1);
  assert.equal(JSON.parse(await fs.readFile(stateFile, 'utf8')).tables.widget.length, 1);
  const accepted = await send(true);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('x-invented-flow'), 'preserved');
  assert.equal(app.state().data.widget.length, 2);
});
