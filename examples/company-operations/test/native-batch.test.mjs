import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {nativeBatchProgram, saveNativeReadArchive} from '../portal-harness/native-batch-prototype.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

test('native archive verifies its exclusive file descriptor and refuses replacement',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-archive-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'read.gz'),bytes=Buffer.alloc(260000,73);
  const receipt=await saveNativeReadArchive(file,bytes);
  assert.equal(receipt.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(receipt.bytes,bytes.length);assert.deepEqual(await fs.readFile(file),bytes);
  await assert.rejects(saveNativeReadArchive(file,Buffer.from('replacement')),{code:'EEXIST'});
  assert.deepEqual(await fs.readFile(file),bytes);
});

const input = () => ({portalOrigin: 'https://portal.example.test', capturePort: 12345,
  requests: [{lane: 'webapi', url: '/_api/widgets?query=one', operationId: 'one'}, {lane: 'liquid', operationId: 'two'}],
  liquidUrls: [{url: '/batch?operationIds=two', ids: ['two']}],
});

test('native batch program treats hostile request metadata as data and uses bounded read workers', async () => {
  const data = input(), hostile = '\"});globalThis.injected=true;//\\` ${globalThis.injected=true}\u2028\u2029';
  data.requests = Array.from({length: 7}, (_, index) => JSON.parse(JSON.stringify({lane: 'webapi', url: '/_api/widgets?index=' + index, operationId: String(index), authoredFetchXml: hostile, ['__proto__']: {injected: true}})));
  data.requests.push({lane: 'liquid', operationId: 'two', authoredFetchXml: hostile});
  let running = 0, maximum = 0, saved, evaluated;
  const calls = [];
  const context = vm.createContext({
    shell: {getTokenDeferred: () => ({done(resolve) {resolve('synthetic-token'); return this;}, fail() {return this;}})},
    fetch: async (url, options) => {
      calls.push({url, options});
      if (options.method === 'POST') {saved = JSON.parse(options.body); return {ok: true};}
      assert.equal(options.redirect, 'error');
      if (url.startsWith('/_api/')) {running++; maximum = Math.max(maximum, running);}
      return {status: 200, headers: {get: () => 'application/json'}, text: async () => {
        await new Promise(resolve => setTimeout(resolve, 1));
        if (url.startsWith('/_api/')) running--;
        return '{"value":[]}';
      }};
    },
  });
  const execute = vm.runInContext(nativeBatchProgram(data), context);
  const page = {goto: async (url, options) => {assert.equal(url, 'https://portal.example.test/permission-lab/'); assert.equal(options.waitUntil, 'domcontentloaded');},
    evaluate: async (callback, value) => {evaluated = value; return callback(value);}};
  const summary = await execute(page);
  assert.equal(context.injected, undefined);
  assert.equal(maximum, 4);
  assert.equal(summary.calls, 8);
  assert.equal(saved.requests[0].authoredFetchXml, hostile);
  assert.equal(Object.hasOwn(evaluated.requests[0], '__proto__'), true);
  assert.equal(Object.getPrototypeOf(evaluated.requests[0]).injected, undefined);
  assert.equal(saved.results.filter(result => result.lane === 'liquid-batch').length, 1);
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:12345/capture');
  assert.ok(calls.filter(call => call.url.startsWith('/_api/')).every(call => call.options.headers.__RequestVerificationToken === 'synthetic-token'));
});

test('native batch program rejects unsafe origins, injected ports and requests leaving the portal', () => {
  for (const capturePort of [0, -1, 65536, 1.5, '12345', "12345/capture');globalThis.injected=true;//"])
    assert.throws(() => nativeBatchProgram({...input(), capturePort}), /loopback port/);
  for (const portalOrigin of ['http://portal.example.test', 'https://user:secret@portal.example.test', 'https://portal.example.test/path', 'https://portal.example.test?query=value'])
    assert.throws(() => nativeBatchProgram({...input(), portalOrigin}), /HTTPS portal origin/);
  for (const url of ['https://other.example.test/_api/widgets', '//other.example.test/_api/widgets', '/_api/../../outside', '/_api/\\other.example.test', '/_api/widgets#fragment', '/_api/widgets\n'])
    assert.throws(() => nativeBatchProgram({...input(), requests: [{lane: 'webapi', url}]}), /portal/);
  for (const url of ['//other.example.test/batch', '/\\other.example.test/batch', 'https://other.example.test/batch'])
    assert.throws(() => nativeBatchProgram({...input(), liquidUrls: [{url, ids: ['two']}]}), /portal/);
});
