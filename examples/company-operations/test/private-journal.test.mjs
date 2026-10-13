import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {savePrivateJson} from '../portal-harness/private-journal.mjs';

test('failed atomic journal replacement preserves the last complete mutation intent',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'paqvilo-journal-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'lease.json'),before={state:'pending',operationId:'owned'},after={state:'verified',operationId:'owned'};
  await savePrivateJson(file,before,{exclusive:true});
  await assert.rejects(savePrivateJson(file,after,{exclusive:true}),error=>error.code==='EEXIST');
  const rename=fs.rename;fs.rename=async()=>{throw Object.assign(new Error('Simulated interrupted replacement'),{code:'EIO'});};
  try{await assert.rejects(savePrivateJson(file,after),/interrupted/);}finally{fs.rename=rename;}
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),before);
  assert.deepEqual(await fs.readdir(root),['lease.json']);
  await savePrivateJson(file,after);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),after);
});
