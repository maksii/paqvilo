import {randomUUID} from 'node:crypto';
import {inspectFlowTrigger,executeFlowDefinition} from './flow-runtime.mjs';
import {compileODataPredicate,parseODataExpression} from './odata-query.mjs';
import {validateServiceProfile} from './local-organization-service.mjs';
const definitionOf=workflow=>workflow?.definition?.properties?.definition??workflow?.definition?.definition;
/** Own asynchronous queue. Source rows have already been saved before arrival.
 * No callback makes a live request or changes the committed caller response. */
export function createFlowTriggerRunner({store,items,workflows,identities,diagnostic=()=>{},limits={},acceptedChains=new Set()}){
 const pending=new Set(),chainRuns=new Map();let closed=false,closing=false,stopSequence=Infinity;
 const record=(code,entry)=>diagnostic({code,...entry});
 const dispatch=(events,{sequence=0}={})=>{
  if(closed)return;
  for(const event of events)for(const item of items().filter(i=>i.kind==='cloud-flow'&&i.contract?.trigger?.kind==='dataverse')){
   if(closing&&sequence>stopSequence&&!acceptedChains.has(event.chain?.id)){record('FLOW_TRIGGER_STOPPED',{operationKey:item.key,message:'A new committed root event arrived after the stop boundary.'});continue;}
   const workflow=workflows().get(item.processId),definition=definitionOf(workflow),trigger=inspectFlowTrigger(definition);
   let mapping;try{mapping=store.resolveMapping(trigger.table);}catch{record('FLOW_TRIGGER_UNSUPPORTED',{operationKey:item.key,message:'The source trigger table cannot be bound to the imported schema.'});continue;}
   const messages={1:['create'],2:['delete'],3:['update'],4:['create','update'],5:['create','delete'],6:['update','delete'],7:['create','update','delete']};
   if(mapping.logicalName!==event.entity||!messages[trigger.message]?.includes(event.operation))continue;
   if(item.mode==='disabled'){record('FLOW_TRIGGER_DISABLED',{operationKey:item.key});continue;}
   if(item.mode==='placeholder'){record('FLOW_TRIGGER_PLACEHOLDER',{operationKey:item.key,message:'Source trigger has no enabled local execution choice.'});continue;}
   if(item.mode==='mock'){record('FLOW_TRIGGER_MOCK',{operationKey:item.key,status:item.configuration?.status??200,sourceActivation:workflow.active??null,message:'Explicit local mock; original trigger logic and backend connection were not executed.'});continue;}
   const chain=event.chain??{id:randomUUID(),depth:0},runs=(chainRuns.get(chain.id)??0)+1;
   if(chain.depth>=Math.min(limits.maxDepth??8,16)||runs>Math.min(limits.maxChainRuns??100,1000)||pending.size>=Math.min(limits.maxPending??100,1000)){record('FLOW_TRIGGER_LIMIT',{operationKey:item.key,chainId:chain.id,depth:chain.depth});continue;}
   chainRuns.set(chain.id,runs);acceptedChains.add(chain.id);if(acceptedChains.size>2000)acceptedChains.delete(acceptedChains.values().next().value);if(chainRuns.size>1000)chainRuns.delete(chainRuns.keys().next().value);
   let task;
   task=store.transact(()=>{
    const oldChain=store.flowChain;store.flowChain={id:chain.id,depth:chain.depth+1};
    try{
     if(!trigger.supported)throw new Error(trigger.errors.join(' '));
     if(workflow.active!==true){if(item.configuration?.activation!=='local-enabled')throw new Error('The imported workflow activation state is not Activated. Choose explicit local activation to exercise this source.');record('FLOW_TRIGGER_ACTIVATION_OVERRIDE',{operationKey:item.key,sourceActivation:workflow.active??null,sourceFile:workflow.file,message:'User selected local activation; exported activation remains unchanged.'});}
     const profile=identities().get(item.processId);validateServiceProfile(profile);
     const grants=profile.grants.filter(g=>g.entity===event.entity&&g.operations.includes('read'));if(!grants.some(g=>!g.predicate||g.predicate(structuredClone(event.row),'read')===true))throw new Error('Trigger backend profile has no matching read grant for the committed source row.');
     if(event.operation==='update'&&trigger.selectColumns.length){const scalar=trigger.selectColumns.filter(name=>{const field=store.fieldDefinition(event.entity,name);if(!field)throw new Error('Select-column field kind is absent from the imported metadata: '+name);return !['lookup','customer','owner'].includes(String(field.dataverseType??field.type??'').toLowerCase());});if(!scalar.some(name=>event.submittedAttributes.includes(name)))return null;}
     if(trigger.filter){if(event.operation==='delete')throw new Error('Delete trigger filters require native payload/filter evidence; this combination is not yet implemented.');const ctx=store.queryContext({admin:true,id:profile.userId},{dialect:'dataverse'});if(!compileODataPredicate(parseODataExpression(trigger.filter,{dialect:'dataverse'}),mapping,ctx)(event.row))return null;}
     if(item.mode!=='exported')throw new Error('Automatic Dataverse triggers support imported definitions, explicit mock or disabled mode.');
     const input={...structuredClone(event.row),SdkMessage:{create:'Create',update:'Update',delete:'Delete'}[event.operation]},answer=executeFlowDefinition({definition,input,store,serviceProfile:profile,steps:item.configuration?.steps,diagnostic:d=>record(d.code,{...d,operationKey:item.key,chainId:chain.id})});
     record('FLOW_TRIGGER_COMPLETED',{operationKey:item.key,chainId:chain.id,status:answer.status,sourceFile:item.sourceFile,payloadScope:'Local committed row snapshot; native payload parity requires separate capture'});
    }catch(error){record('FLOW_TRIGGER_FAILED',{operationKey:item.key,chainId:chain.id,error:{code:error.code??'LocalFlowTriggerUnsupported',message:error.message}});}
    finally{store.flowChain=oldChain;}
    return null;
   }).catch(error=>record('FLOW_TRIGGER_QUEUE_FAILED',{operationKey:item.key,error:{code:error.code,message:error.message}})).finally(()=>pending.delete(task));
   pending.add(task);
  }
 };
 const unsubscribe=store.addCommittedEvents(dispatch);
 const drain=async()=>{await store.flushCommittedEvents();while(pending.size){await Promise.all([...pending]);await store.flushCommittedEvents();}};
 const beginClose=sequence=>{closing=true;stopSequence=Math.min(stopSequence,sequence??store.committedEventSequence??0);};
 return {drain,beginClose,async close(){beginClose();await drain();closed=true;unsubscribe();chainRuns.clear();},status:()=>({pending:pending.size,closed})};
}
