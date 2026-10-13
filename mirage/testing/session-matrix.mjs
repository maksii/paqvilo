import {performance} from 'node:perf_hooks';

const integer=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
/** Run cases against independent visitors with bounded in-flight work.
 * The runtime/store is shared; isolate fixtures for concurrent writes. Calls
 * execute once. Cancellation drains started work and reports unstarted cells.
 * onResult is serialized for durable append-only recording by the caller. */
export async function runSessionMatrix({sessions,cases,concurrency=10,signal,onResult,failFast=false,maxCells=1000000}={}) {
 if(!Array.isArray(sessions)||!sessions.length||!Array.isArray(cases)||!cases.length||!integer(concurrency,1,64)||!integer(maxCells,1,1000000)||typeof failFast!=='boolean'||onResult!==undefined&&typeof onResult!=='function')throw new Error('Session matrix needs nonempty visitors/cases and bounded concurrency.');
 if(sessions.some(session=>typeof session?.id!=='string'||typeof session.request!=='function')||new Set(sessions.map(session=>session.id)).size!==sessions.length)throw new Error('Matrix visitors require unique identities and request clients.');
 if(cases.some(item=>typeof item?.id!=='string'||!item.id||item.id.length>160||typeof item.run!=='function')||new Set(cases.map(item=>item.id)).size!==cases.length)throw new Error('Matrix cases need unique bounded identities and executable callbacks.');
 const total=sessions.length*cases.length;if(total>maxCells)throw new Error('Session matrix exceeds its explicit cell bound.');
 const started=performance.now(),controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
 // Each visitor has at most one running case. Independent visitors can advance
 // without a global barrier, while dependent read/write cases retain their order.
 const ready=sessions.map((_session,index)=>index),nextCase=sessions.map(()=>0);
 let head=0,active=0,peak=0,recording=Promise.resolve(),recordingFailure;
 const results=[];
 const worker=async()=>{while(!combined.aborted&&head<ready.length){
  const sessionIndex=ready[head++],caseIndex=nextCase[sessionIndex]++,index=caseIndex*sessions.length+sessionIndex,session=sessions[sessionIndex],plan=cases[caseIndex],time=performance.now();active++;peak=Math.max(peak,active);
  if(head>4096&&head*2>ready.length){ready.splice(0,head);head=0;}
  let row;
  try{const value=await plan.run(session,{signal:combined,index,sessionId:session.id,caseId:plan.id});row={index,sessionId:session.id,caseId:plan.id,state:'completed',value};}
  catch(error){row={index,sessionId:session.id,caseId:plan.id,state:combined.aborted?'cancelled':'failed',errorCode:/^[a-z\d_.-]{1,160}$/i.test(String(error?.code??error?.name??''))?String(error.code??error.name):'MatrixCellFailed'};if(failFast)controller.abort();}
  finally{active--;}
  row.durationMs=performance.now()-time;results.push(row);
  if(onResult){recording=recording.then(()=>onResult(row));try{await recording;}catch(error){recordingFailure=error;controller.abort();}}
  if(nextCase[sessionIndex]<cases.length)ready.push(sessionIndex);
 }};
 await Promise.all(Array.from({length:Math.min(concurrency,total)},worker));
 if(recordingFailure)throw recordingFailure;
 results.sort((a,b)=>a.index-b.index);
 const durationMs=performance.now()-started,latencies=results.map(row=>row.durationMs).sort((a,b)=>a-b);
 return {total,started:results.length,completed:results.filter(row=>row.state==='completed').length,failed:results.filter(row=>row.state==='failed').length,cancelled:results.filter(row=>row.state==='cancelled').length,unstarted:total-results.length,aborted:combined.aborted,concurrency,peakConcurrency:peak,durationMs,cellsPerSecond:durationMs?results.length*1000/durationMs:0,
  latencyMs:{p50:latencies.length?latencies[Math.ceil(latencies.length*.5)-1]:null,p95:latencies.length?latencies[Math.ceil(latencies.length*.95)-1]:null,max:latencies.at(-1)??null},results};
}
