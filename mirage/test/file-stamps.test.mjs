// @test-kind contract: complete fresh metadata is captured off the HTTP thread, with exact BigInt stamps, causal message/exit gates and no surviving workers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { Worker, MessageChannel } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { channel } from 'node:diagnostics_channel';
import { statFiles } from '../lib/file-stamps.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

async function fixture(t, body) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'metadata-owned-worker-'));
  const workers = [];
  ownedFixture(t).add(async () => {
    for (const worker of workers) if (worker.threadId !== -1) await worker.terminate();
  });
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const workerFile = path.join(root, 'fixture.mjs');
  if (body) await fs.writeFile(workerFile, body);
  return {
    root,
    workers,
    factory(url, options) {
      assert.match(url.href, /file-stamps-worker\.mjs$/);
      assert.deepEqual(options.execArgv, []);
      assert.deepEqual(options.env, {});
      const worker = new Worker(body ? pathToFileURL(workerFile) : url, options);
      workers.push(worker);
      return worker;
    },
  };
}
const stampFields = (stat) => ({ size: stat.size, ino: stat.ino, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs });

test('the actual packaged worker preserves order, vanished-file nulls and every native nanosecond field', async (t) => {
  const fx = await fixture(t);
  const first = path.join(fx.root, 'first'),
    second = path.join(fx.root, 'second'),
    gone = path.join(fx.root, 'gone');
  await fs.writeFile(first, 'first');
  await fs.writeFile(second, 'second');
  const expected = [await fs.stat(second, { bigint: true }), await fs.stat(first, { bigint: true })].map(stampFields);
  assert.deepEqual(await statFiles([second, gone, first], { workerFactory: fx.factory }), [
    expected[0],
    null,
    expected[1],
  ]);
  assert.equal(fx.workers.length, 1);
  assert.equal(fx.workers[0].threadId, -1, 'the owning worker exited before results became available');
});

test('a gated metadata worker leaves HTTP responsive and a valid result cannot settle before worker exit', async (t) => {
  const fx = await fixture(
    t,
    `import fs from 'node:fs'; import {parentPort,workerData} from 'node:worker_threads';
const gate=new Int32Array(workerData.gate); workerData.control.postMessage('ready'); workerData.control.close();
Atomics.wait(gate,0,0); const stamps=workerData.files.map(file=>{const s=fs.statSync(file,{bigint:true});return{size:s.size,ino:s.ino,mtimeNs:s.mtimeNs,ctimeNs:s.ctimeNs}});
parentPort.postMessage({version:1,id:workerData.id,checked:stamps.length,stamps}); Atomics.wait(gate,1,0);`,
  );
  const file = path.join(fx.root, 'source');
  await fs.writeFile(file, 'owned source');
  const gate = new Int32Array(new SharedArrayBuffer(8));
  t.after(() => {
    for (const index of [0, 1]) {
      Atomics.store(gate, index, 1);
      Atomics.notify(gate, index);
    }
  });
  const { port1, port2 } = new MessageChannel();
  t.after(() => {
    port1.close();
    port2.close();
  });
  const ready = once(port1, 'message'),
    result = Promise.withResolvers();
  const walking = statFiles([file], {
    workerFactory(url, options) {
      const worker = fx.factory(url, {
        ...options,
        workerData: { ...options.workerData, gate: gate.buffer, control: port2 },
        transferList: [port2],
      });
      worker.once('message', result.resolve);
      return worker;
    },
  });
  let settled = false;
  walking.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await ready;
  const server = http.createServer((_req, res) => res.end('responsive'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  ownedFixture(t).add(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}`)).text(), 'responsive');
  assert.equal(settled, false, 'a blocked worker does not block HTTP or produce an early result');
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
  await result.promise;
  await setImmediate();
  assert.equal(settled, false, 'a received valid message is insufficient while its writer remains alive');
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
  assert.deepEqual(await walking, [stampFields(await fs.stat(file, { bigint: true }))]);
  assert.equal(fx.workers[0].threadId, -1);
});

test('an actual native stat failure retains its error code and the worker exits before rejection', async (t) => {
  const fx = await fixture(t);
  const after = path.join(fx.root, 'must-not-be-read');
  await fs.writeFile(after, 'later metadata');
  const observed = [],
    metadata = channel('paqvilo.metadata-walk');
  const observe = (event) => observed.push(event);
  metadata.subscribe(observe);
  t.after(() => metadata.unsubscribe(observe));
  await assert.rejects(statFiles([123, after], { workerFactory: fx.factory }), {
    name: 'TypeError',
    code: 'ERR_INVALID_ARG_TYPE',
  });
  assert.equal(fx.workers[0].threadId, -1);
  assert.equal(observed.at(-1).stage, 'failed');
  assert.equal(observed.at(-1).checked, 1, 'the first native error suppresses all later stat calls');
});

for (const mode of ['crash', 'no-result', 'wrong-id', 'incomplete', 'sparse', 'duplicate'])
  test(`a ${mode} worker cannot publish successful metadata`, async (t) => {
    const body = `import {parentPort,workerData} from 'node:worker_threads';
const stamp={size:1n,ino:9007199254740993001n,mtimeNs:1794930000000000001n,ctimeNs:1794930000000000002n};
const packet={version:1,id:workerData.id,checked:1,stamps:[stamp]};
${mode === 'wrong-id' ? "packet.id='foreign';" : ''}
${mode === 'incomplete' ? 'packet.stamps=[];' : ''}
${mode === 'sparse' ? 'packet.stamps=new Array(1);' : ''}
${mode === 'no-result' ? '' : 'parentPort.postMessage(packet);'}
${mode === 'duplicate' ? 'parentPort.postMessage(packet);' : ''}
${mode === 'crash' ? 'process.exit(7);' : ''}`;
    const fx = await fixture(t, body);
    await assert.rejects(statFiles(['owned'], { workerFactory: fx.factory }), { code: 'MetadataWorkerFailed' });
    assert.equal(fx.workers[0].threadId, -1);
  });

test('an error packet preserves exact filesystem error fields and no metadata success', async (t) => {
  const fx = await fixture(
    t,
    `import {parentPort,workerData} from 'node:worker_threads';parentPort.postMessage({version:1,id:workerData.id,checked:1,error:{name:'Error',message:'fixture access denied',code:'EACCES',errno:-13,syscall:'stat',path:'owned-fixture'}});`,
  );
  await assert.rejects(statFiles(['owned'], { workerFactory: fx.factory }), {
    code: 'EACCES',
    errno: -13,
    syscall: 'stat',
    path: 'owned-fixture',
  });
  assert.equal(fx.workers[0].threadId, -1);
});

test('empty walks create no worker and synchronous worker setup failures keep their original identity', async () => {
  let started = 0;
  const error = new Error('owned worker setup refused');
  const workerFactory = () => {
    started++;
    throw error;
  };
  assert.deepEqual(await statFiles([], { workerFactory }), []);
  assert.equal(started, 0);
  await assert.rejects(statFiles(['owned'], { workerFactory }), (failure) => failure === error);
  assert.equal(started, 1);
});
