import {randomUUID} from 'node:crypto';
import {messageNameOf,runPluginPhase} from './exported-plugins.mjs';

// The Dataverse error number of a failed run: the inner code a plug-in fault carries (plugin-fault.mjs), else 0.
const errorNumber=error=>{const code=error?.details?.innerCode;return /^0x[0-9a-f]+$/i.test(code??'')?Number.parseInt(code,16)|0:0;};
/** The asyncoperation row of one async step run (operationtype 1, System Event). Written in the runner's own store transaction:
 * dataverse-async's systemJob defers its work to a later tick, and this run must keep its portal timing. Learn's states:
 * Ready (0/0), Locked while running (2/20), then Completed Succeeded (3/30) or Failed (3/31). A succeeded run of a step with
 * asyncautodelete is removed. ponytail: the Ready and Locked states are written in the same transaction, so only the final state is observable. */
function systemJobOf(store,item,event,chain){
 const table=store.state.tables.asyncoperation??=[],idColumn=store.resolveMapping(event.entity)?.idColumn,recordId=idColumn?event.row?.[idColumn]??null:null,now=()=>new Date().toISOString();
 const job={asyncoperationid:randomUUID(),name:item.name??item.id,operationtype:1,statecode:0,statuscode:0,owningextensionid:{id:item.id,logical_name:'sdkmessageprocessingstep',name:item.name},regardingobjectid:recordId?{id:recordId,logical_name:event.entity}:null,regardingobjecttypecode:event.entity,primaryentitytype:event.entity,messagename:messageNameOf(event.operation),correlationid:chain.id,depth:chain.depth+1,createdon:now()};
 store.insertRow('asyncoperation',table,job);
 Object.assign(job,{statecode:2,statuscode:20,startedon:now()});
 const autodelete=store.tableRows('sdkmessageprocessingstep').find(row=>String(row.sdkmessageprocessingstepid).toLowerCase()===String(item.id).toLowerCase())?.asyncautodelete===true;
 return{finish(error){
  if(!error&&autodelete){store.removeRow('asyncoperation',table,table.indexOf(job));return;}
  // unverified: LC-P7c. friendlymessage carries the plug-in's own message; native's user-facing text is not captured.
  const message=error?String(error.message??error):null;
  Object.assign(job,error?{statecode:3,statuscode:31,completedon:now(),message,friendlymessage:message,errorcode:errorNumber(error)}:{statecode:3,statuscode:30,completedon:now()});
 },
 // P6: a web hook the simulator cannot deliver in any form is Canceled (statuscode 32), with the message as its reason.
 cancel(message){Object.assign(job,{statecode:3,statuscode:32,completedon:now(),message,friendlymessage:message});}};
}

/** Local post-save queue for explicitly selected source mode-1 registrations.
 * Each SDK write is independent. A later job failure cannot reject the original
 * caller or undo completed SDK requests. This is not the Dataverse async service.
 * systemJobs() is true while the Dataverse API is on: each run then also writes its asyncoperation row (P7). */
export function createAsyncPluginRunner({store,items,handlers,runtimes,webhooks=null,diagnostic=()=>{},limits={},acceptedChains=new Set(),systemJobs=()=>false}){
 const pending=new Set(),runs=new Map();let closed=false,closing=false,stopSequence=Infinity;
 // P6: an asynchronous web hook is delivered after commit. Its System Job is Locked while the POST runs, then Succeeded (an endpoint
 // the simulator does not contact also succeeds, with a WEBHOOK_NOT_CONTACTED diagnostic), Failed, or Canceled (a contract other than 8).
 const deliverWebhook=async(item,event,chain)=>{
  if(!webhooks){diagnostic({code:'WEBHOOK_NOT_DELIVERED',stepId:item.id,reason:'no-adapter'});return;}
  let job=null;
  await store.transact(()=>{job=systemJobs()?systemJobOf(store,item,event,chain):null;});
  try{
   const answer=await webhooks.afterCommit({item,entity:event.entity,operation:event.operation,stage:40,target:structuredClone(event.target??{}),record:structuredClone(event.row),previous:structuredClone(event.previous??null),identity:structuredClone(event.identity??{}),changedAttributes:event.submittedAttributes,depth:chain.depth+1,correlationId:chain.id,diagnostic});
   await store.transact(()=>(answer?.canceled?job?.cancel(answer.canceled):job?.finish(null)));
   diagnostic({code:'PLUGIN_ASYNC_COMPLETED',stepId:item.id,chainId:chain.id,sourceFile:item.sourceFile,mode:item.mode});
  }catch(error){
   await store.transact(()=>job?.finish(error));
   diagnostic({code:'PLUGIN_ASYNC_FAILED',stepId:item.id,chainId:chain.id,error:{code:error.code??'LocalPluginAsyncError',message:error.message}});
  }
 };
 const dispatch=(events,{sequence=0}={})=>{
  if(closed)return;
  for(const event of events){
   if(closing&&sequence>stopSequence&&!acceptedChains.has(event.chain?.id)){diagnostic({code:'PLUGIN_ASYNC_STOPPED',message:'A new committed root event arrived after the stop boundary.'});continue;}
   const selected=items().filter(item=>item.enabled&&item.contract?.mode===1&&item.entity===event.entity&&String(item.message).toLowerCase()===event.operation&&item.stage===40&&(!['update','onexternalupdated'].includes(event.operation)||!item.filteringAttributes.length||item.filteringAttributes.some(name=>event.submittedAttributes.includes(name)))).sort((a,b)=>a.rank-b.rank||a.id.localeCompare(b.id));
   for(const item of selected){
    const chain=event.chain??{id:randomUUID(),depth:0},count=(runs.get(chain.id)??0)+1;
    if(chain.depth>=Math.min(limits.maxDepth??8,16)||count>Math.min(limits.maxChainRuns??100,1000)||pending.size>=Math.min(limits.maxPending??100,1000)){diagnostic({code:'PLUGIN_ASYNC_LIMIT',stepId:item.id,chainId:chain.id});continue;}
    runs.set(chain.id,count);acceptedChains.add(chain.id);if(acceptedChains.size>2000)acceptedChains.delete(acceptedChains.values().next().value);if(runs.size>1000)runs.delete(runs.keys().next().value);
    let task;
    if(item.mode==='webhook'){task=deliverWebhook(item,event,chain).catch(error=>diagnostic({code:'PLUGIN_ASYNC_QUEUE_FAILED',stepId:item.id,error:{code:error.code,message:error.message}})).finally(()=>pending.delete(task));pending.add(task);continue;}
    task=store.transact(()=>{
     const previousChain=store.flowChain,previousFlag=store.pluginInTransaction,previousParent=store.pluginParentContext;
     store.flowChain={id:chain.id,depth:chain.depth+1};store.pluginInTransaction=false;store.pluginParentContext=null;
     let job=null;
     try{
      job=systemJobs()?systemJobOf(store,item,event,chain):null;
      runPluginPhase({store,items:[item],handlers,runtimes,entity:event.entity,operation:event.operation,stage:40,target:structuredClone(event.target??{}),record:structuredClone(event.row),previous:structuredClone(event.previous??null),identity:structuredClone(event.identity??{}),changedAttributes:event.submittedAttributes,initialFrame:event.frame,asyncExecution:true,diagnostic});
      job?.finish(null);
      diagnostic({code:'PLUGIN_ASYNC_COMPLETED',stepId:item.id,chainId:chain.id,sourceFile:item.sourceFile,mode:item.mode});
     }catch(error){job?.finish(error);diagnostic({code:'PLUGIN_ASYNC_FAILED',stepId:item.id,chainId:chain.id,error:{code:error.code??'LocalPluginAsyncError',message:error.message}});}
     finally{store.flowChain=previousChain;store.pluginInTransaction=previousFlag;store.pluginParentContext=previousParent;}
    }).catch(error=>diagnostic({code:'PLUGIN_ASYNC_QUEUE_FAILED',stepId:item.id,error:{code:error.code,message:error.message}})).finally(()=>pending.delete(task));
    pending.add(task);
   }
  }
 };
 const unsubscribe=store.addCommittedEvents(dispatch);
 const drain=async()=>{await store.flushCommittedEvents();while(pending.size){await Promise.all([...pending]);await store.flushCommittedEvents();}};
 const beginClose=sequence=>{closing=true;stopSequence=Math.min(stopSequence,sequence??store.committedEventSequence??0);};
 return {drain,beginClose,async close(){beginClose();await drain();closed=true;unsubscribe();runs.clear();},status:()=>({pending:pending.size,closed})};
}
