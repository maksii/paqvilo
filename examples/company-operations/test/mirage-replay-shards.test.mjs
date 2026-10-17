import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {runMirageReplayShards} from '../portal-harness/mirage-replay-shards.mjs';
import {replayCellShard} from '../portal-harness/mirage-campaign-replay.mjs';
test('ten actual process workers own separate cell/cache/receipt namespaces and unqualified evidence stays unqualified',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'paq-sharded-replay-'));try{
  const module=new URL('../portal-harness/mirage-campaign-replay.mjs',import.meta.url).href,script=path.join(directory,'fixture.mjs');
  await fs.writeFile(script,`import fs from'node:fs/promises';import{runMirageReplayCampaign}from${JSON.stringify(module)};const job=JSON.parse(await fs.readFile(process.argv[2]));const summary=await runMirageReplayCampaign(job,{replay:async()=>{await new Promise(r=>setTimeout(r,30));return {physicalReads:1,qualifiedReads:0,allQualified:false};}});console.log(JSON.stringify(summary));`);
  const fixture=path.join(directory,'fixture.json');await fs.writeFile(fixture,'{}');const {createHash}=await import('node:crypto'),spec={file:fixture,sha256:createHash('sha256').update('{}').digest('hex')},inputs=Object.fromEntries(['schema','catalogue','observed','serviceProfiles','assemblyReceipt','snapshotBefore','snapshotAfter','capture','registrationBefore','registrationAfter','siteBefore','siteAfter'].map(key=>[key,spec]));
  const cells=Array.from({length:20},(_,index)=>({id:'cell-'+index,inputs:{}})),job={schemaVersion:1,inputs,cells,outputRoot:path.join(directory,'results'),cacheRoot:path.join(directory,'cache')},pids=[];
  const runWorker=jobFile=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[script,jobFile],{stdio:['ignore','pipe','pipe'],windowsHide:true}),started=Date.now();let out='',err='';child.stdout.on('data',chunk=>{out+=chunk;});child.stderr.on('data',chunk=>{err+=chunk;});child.on('error',reject);child.on('exit',code=>{if(code!==0)reject(new Error(err));else {pids.push(child.pid);resolve({pid:child.pid,durationMs:Date.now()-started,summary:JSON.parse(out)});}});});
  const result=await runMirageReplayShards(job,{workers:10,runWorker});assert.equal(new Set(pids).size,10);assert.equal(result.cells,20);assert.equal(result.physicalReads,20);assert.equal(result.qualified,0);assert.equal(result.allQualified,false);
  const receipt=JSON.parse(await fs.readFile(result.receiptFile));assert.equal(receipt.workers.length,10);for(const cell of receipt.cells)assert.equal(cell.shard,replayCellShard(cell.id,10));assert.equal(new Set(receipt.workers.map(row=>path.dirname(row.ledgerFile))).size,10);
  const shard=receipt.workers[0],ledger=JSON.parse(await fs.readFile(shard.ledgerFile));if(ledger.cells.length){await fs.appendFile(ledger.cells[0].resultFile,'corrupt');await assert.rejects(runMirageReplayShards(job,{workers:10,runWorker}),/Parallel replay failed/);}
 }finally{await fs.rm(directory,{recursive:true,force:true,maxRetries:5});}
});
