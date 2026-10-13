import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {savePrivateJson} from './private-journal.mjs';
import {replayRuntimeFingerprint,replayCellShard,boundedReplayBytes,replayCells,loadReplayCellInputs,replayRoleWitness} from './mirage-campaign-replay.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const stable=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const module=fileURLToPath(new URL('./mirage-campaign-replay.mjs',import.meta.url));
function spawnWorker(jobFile,{signal}={}){return new Promise((resolve,reject)=>{
 if(signal?.aborted){reject(new Error('Owned replay worker was cancelled before launch.'));return;}
 const child=spawn(process.execPath,[module,'--job',jobFile],{windowsHide:true,stdio:['ignore','pipe','pipe']}),startedAt=Date.now();let stdout='',stderr='',failure;
 const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});
 const read=(name,chunk)=>{if(failure)return;if(name==='stdout')stdout+=chunk;else stderr+=chunk;if(stdout.length>16384||stderr.length>16384){failure=new Error('Owned replay worker exceeded bounded control output.');child.kill();}};
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',chunk=>read('stdout',chunk));child.stderr.on('data',chunk=>read('stderr',chunk));child.once('error',reject);
 child.once('exit',code=>{signal?.removeEventListener('abort',abort);if(failure)reject(failure);else if(code!==0)reject(Object.assign(new Error('Owned replay worker failed; inspect its private shard ledger.'),{workerPid:child.pid,exitCode:code}));else {try{const summary=JSON.parse(stdout);if(summary.pid!==child.pid)throw new Error('Worker PID receipt mismatch.');resolve({pid:child.pid,durationMs:Date.now()-startedAt,summary});}catch(error){reject(error);}}});
});}
/** Actual Node child processes: each has isolated store/cache/CLR host/session.
 * No native identity/login is created and no native request is sent. Aggregation
 * verifies immutable physical receipts, never trusts a success counter alone. */
export async function runMirageReplayShards(job,{workers=10,runWorker=spawnWorker,signal}={}){
 if(!Number.isInteger(workers)||workers<1||workers>10||!path.isAbsolute(job?.outputRoot??'')||!path.isAbsolute(job?.cacheRoot??''))throw new Error('Parallel replay requires one to ten processes and absolute owned output/cache roots.');
 const parentRoot=path.join(job.outputRoot,'parallel'),lease=path.join(parentRoot,'controller.lock');await fs.mkdir(parentRoot,{recursive:true});const owner=randomUUID();await savePrivateJson(lease,{owner,pid:process.pid},{exclusive:true});
 const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();try{
  let runtimeSourceArchive;const runtimeSha256=await replayRuntimeFingerprint({archiveRoot:path.join(parentRoot,'runtime-sources'),onArchive:receipt=>{runtimeSourceArchive=receipt;}}),parentJobSha256=hash(Buffer.from(stable(job))),jobs=[];
  for(let index=0;index<workers;index++){
   const outputRoot=path.join(parentRoot,'shard-'+index),cacheRoot=path.join(job.cacheRoot,'shard-'+index),childJob={...job,outputRoot,cacheRoot,shard:{index,count:workers}},jobFile=path.join(parentRoot,'job-'+index+'.json');
   try{await savePrivateJson(jobFile,childJob,{exclusive:true});}catch(error){if(error.code!=='EEXIST')throw error;if(stable(JSON.parse(await boundedReplayBytes(jobFile,65536)))!==stable(childJob))throw new Error('An immutable shard job changed.');}
   jobs.push({index,job:childJob,jobFile});
  }
  const outcomes=await Promise.allSettled(jobs.map(async row=>{try{return {...row,result:await runWorker(row.jobFile,{signal:controller.signal})};}catch(error){controller.abort();throw error;}})),failed=outcomes.filter(outcome=>outcome.status==='rejected');
  if(failed.length)throw new AggregateError(failed.map(outcome=>outcome.reason),'Parallel replay failed; no aggregate qualification. Owned workers have exited.');
  const declaredCells=new Map((await replayCells(job)).map(cell=>[cell.id,cell])),cells=[],workerReceipts=[],roleMasks=new Set(),runIds=new Set(),operationIds=new Set();for(const outcome of outcomes){const {index,job:childJob,result}=outcome.value,ledgerFile=path.join(childJob.outputRoot,'replay.json'),bytes=await boundedReplayBytes(ledgerFile),ledger=JSON.parse(bytes);
   if(!Number.isInteger(result.pid)||result.pid<=0||result.summary?.pid!==result.pid||ledger.runtimeSha256!==runtimeSha256||ledger.jobSha256!==hash(Buffer.from(stable(childJob))))throw new Error('A shard PID/runtime/job receipt does not match its parent.');
   const latest=new Map();for(const entry of ledger.cells)latest.set(entry.id,entry);for(const entry of latest.values()){
    if(replayCellShard(entry.id,workers)!==index||entry.state!=='complete'||path.dirname(entry.resultFile)!==childJob.outputRoot)throw new Error('Shard cell ownership/completeness is invalid.');
    const declared=declaredCells.get(entry.id);if(!declared||entry.inputSha256!==hash(Buffer.from(stable(declared))))throw new Error('An actual shard cell specification changed or is absent.');
    const {inputs}=await loadReplayCellInputs(childJob,declared),roleWitness=replayRoleWitness(childJob,declared,inputs);
    const bytes=await boundedReplayBytes(entry.resultFile),body=JSON.parse(bytes);if(hash(bytes)!==entry.resultSha256||entry.allQualified!==(body.allQualified===true)||entry.physicalReads!==body.physicalReads||entry.qualifiedReads!==body.qualifiedReads||!Number.isInteger(body.physicalReads)||body.physicalReads<1||!Number.isInteger(body.qualifiedReads)||body.qualifiedReads<0||body.qualifiedReads>body.physicalReads||stable(body.roleWitness??null)!==stable(roleWitness)||body.allQualified===true&&(body.qualifiedReads!==body.physicalReads||body.sourceWitness?.verified!==true||body.wireSourceWitness?.verified!==true||body.pages?.length!==body.physicalReads||body.pages.some(page=>page.qualified!==true)||roleWitness&&!roleWitness.complete))throw new Error('Shard result receipt is incomplete, changed or inconsistent.');
    if(roleWitness){if(roleMasks.has(roleWitness.mask))throw new Error('Role masks repeat across process shards.');roleMasks.add(roleWitness.mask);for(const[values,seen]of [[roleWitness.runIds,runIds],[roleWitness.operationIds,operationIds]])for(const value of values){if(seen.has(value))throw new Error('Native Run/operation identities repeat across role process shards.');seen.add(value);}}cells.push({...entry,shard:index});
   }workerReceipts.push({index,pid:result.pid,durationMs:result.durationMs,ledgerFile,ledgerSha256:hash(bytes)});
  }
  if(new Set(workerReceipts.map(row=>row.pid)).size!==workers||new Set(cells.map(row=>row.id)).size!==cells.length||await replayRuntimeFingerprint()!==runtimeSha256)throw new Error('Process identities, cell ownership or runtime source stability failed.');
  const expectedCells=job.expectedCells??job.cells?.length;if(!Number.isInteger(expectedCells)||expectedCells<1)throw new Error('Parent replay coverage requires an explicit denominator.');
  const qualified=cells.filter(row=>row.allQualified).length,receipt={schemaVersion:1,kind:'OriginalDllParallelProcessReplay',parentJobSha256,runtimeSha256,runtimeSourceArchive,workers:workerReceipts,cells,expectedCells,qualified,coverageScope:job.roleCampaign?'Frozen native role-mask lattice':'Physical-only diagnostic; exhaustive roles unqualified',exhaustiveRoleCoverageQualified:Boolean(job.roleCampaign)&&expectedCells===4096&&roleMasks.size===4096&&qualified===4096,allQualified:cells.length===expectedCells&&qualified===expectedCells,physicalReads:cells.reduce((sum,row)=>sum+row.physicalReads,0),qualifiedReads:cells.reduce((sum,row)=>sum+row.qualifiedReads,0),createdAt:new Date().toISOString()};
  const file=path.join(parentRoot,'aggregate-'+randomUUID()+'.json');await savePrivateJson(file,receipt,{exclusive:true});return {processes:workers,expectedCells,cells:cells.length,qualified,allQualified:receipt.allQualified,exhaustiveRoleCoverageQualified:receipt.exhaustiveRoleCoverageQualified,physicalReads:receipt.physicalReads,qualifiedReads:receipt.qualifiedReads,receiptFile:file};
 }finally{signal?.removeEventListener('abort',abort);let actual;try{actual=JSON.parse(await boundedReplayBytes(lease,65536));}catch{}if(actual?.owner===owner)await fs.unlink(lease);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--job'||args[2]!=='--workers')throw new Error('Usage: node mirage-replay-shards.mjs --job <private job.json> --workers <1..10>');const controller=new AbortController(),abort=()=>controller.abort();process.once('SIGINT',abort);process.once('SIGTERM',abort);try{console.log(JSON.stringify(await runMirageReplayShards(JSON.parse(await boundedReplayBytes(path.resolve(args[1]),65536)),{workers:Number(args[3]),signal:controller.signal})));}finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
}
