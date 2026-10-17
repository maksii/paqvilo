import {randomUUID} from 'node:crypto';
import {runPluginPhase} from './exported-plugins.mjs';

/** Local post-save queue for explicitly selected source mode-1 registrations.
 * Each SDK write is independent. A later job failure cannot reject the original
 * caller or undo completed SDK requests. This is not the Dataverse async service. */
export function createAsyncPluginRunner({store,items,handlers,runtimes,diagnostic=()=>{},limits={},acceptedChains=new Set()}){
 const pending=new Set(),runs=new Map();let closed=false,closing=false,stopSequence=Infinity;
 const dispatch=(events,{sequence=0}={})=>{
  if(closed)return;
  for(const event of events){
   if(closing&&sequence>stopSequence&&!acceptedChains.has(event.chain?.id)){diagnostic({code:'PLUGIN_ASYNC_STOPPED',message:'A new committed root event arrived after the stop boundary.'});continue;}
   const selected=items().filter(item=>item.enabled&&item.contract?.mode===1&&item.entity===event.entity&&String(item.message).toLowerCase()===event.operation&&item.stage===40&&(event.operation!=='update'||!item.filteringAttributes.length||item.filteringAttributes.some(name=>event.submittedAttributes.includes(name)))).sort((a,b)=>a.rank-b.rank||a.id.localeCompare(b.id));
   for(const item of selected){
    const chain=event.chain??{id:randomUUID(),depth:0},count=(runs.get(chain.id)??0)+1;
    if(chain.depth>=Math.min(limits.maxDepth??8,16)||count>Math.min(limits.maxChainRuns??100,1000)||pending.size>=Math.min(limits.maxPending??100,1000)){diagnostic({code:'PLUGIN_ASYNC_LIMIT',stepId:item.id,chainId:chain.id});continue;}
    runs.set(chain.id,count);acceptedChains.add(chain.id);if(acceptedChains.size>2000)acceptedChains.delete(acceptedChains.values().next().value);if(runs.size>1000)runs.delete(runs.keys().next().value);
    let task;
    task=store.transact(()=>{
     const previousChain=store.flowChain,previousFlag=store.pluginInTransaction,previousParent=store.pluginParentContext;
     store.flowChain={id:chain.id,depth:chain.depth+1};store.pluginInTransaction=false;store.pluginParentContext=null;
     try{
      runPluginPhase({store,items:[item],handlers,runtimes,entity:event.entity,operation:event.operation,stage:40,target:structuredClone(event.target??{}),record:structuredClone(event.row),previous:structuredClone(event.previous??null),identity:structuredClone(event.identity??{}),changedAttributes:event.submittedAttributes,initialFrame:event.frame,asyncExecution:true,diagnostic});
      diagnostic({code:'PLUGIN_ASYNC_COMPLETED',stepId:item.id,chainId:chain.id,sourceFile:item.sourceFile,mode:item.mode});
     }catch(error){diagnostic({code:'PLUGIN_ASYNC_FAILED',stepId:item.id,chainId:chain.id,error:{code:error.code??'LocalPluginAsyncError',message:error.message}});}
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
