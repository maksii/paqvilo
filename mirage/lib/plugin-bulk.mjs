import {DataError} from './data-error.mjs';
import {sdkValueToRecord} from './local-organization-service.mjs';
import {handoffPluginResponse} from './plugin-response.mjs';
const emptyId='00000000-0000-0000-0000-000000000000';
const uuid=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const fail=(message,code='LocalPluginBulkUnsupported',status=501)=>{throw new DataError(message,status,code);};
/** Explicit standard-table source capability only. Mixed single/multiple source
 * stage ordering needs native evidence; this adapter never silently reorders it. */
export function executeBulkRecords({store,entity,operation,targets,identity,authorize,responseToken}){
 const mapping=store.resolveMapping(entity),primary=mapping.idColumn,update=operation==='updatemultiple',single=update?'update':'create';
 if(!['createmultiple','updatemultiple'].includes(operation)||!Array.isArray(targets)||!targets.length||targets.length>1000)fail('Bulk SDK targets must contain 1-1000 records of one supported message.');
 if(store.pluginPipeline&&store.pluginPipelineActive({entity:mapping.logicalName,operation:single}))fail('Mixed single-record and bulk registrations require source-qualified native merged-pipeline ordering.');
 const previous=[],ids=new Set();
 for(const target of targets){
  if(target?.$type!=='Entity'||target.logicalName!==mapping.logicalName||!target.attributes||typeof target.attributes!=='object'||Array.isArray(target.attributes))fail('Bulk Targets must be typed entities of one exact logical table.', 'LocalPluginBulkInput',400);
  if(update&&(!uuid.test(target.id)||target.id===emptyId))fail('UpdateMultiple requires each original entity ID.','LocalPluginBulkInput',400);
  target.id??=emptyId;
  if(Object.hasOwn(target.attributes,primary))fail('Bulk identity belongs to Entity.Id, not a conflicting primary-key attribute.','LocalPluginBulkInput',400);
  if(target.id!==emptyId){if(!uuid.test(target.id)||ids.has(target.id.toLowerCase()))fail('Duplicate or malformed bulk entity identity.','LocalPluginBulkInput',400);ids.add(target.id.toLowerCase());}
  const before=update?store.get(entity,target.id,identity,{skipPluginRead:true}):null;if(update&&!before)fail('Bulk target record not found.','NotFound',404);
  const input=sdkValueToRecord(target);authorize(single,update?{...before,...input}:input,before);previous.push(before);
 }
 const original=targets.map(target=>({id:target.id??emptyId,logicalName:target.logicalName})),holder={[primary]:emptyId},inherited=store.pluginInTransaction;
 const check=()=>{const unique=new Set();if(targets.length!==original.length||targets.some((target,index)=>{if(target?.$type!=='Entity'||target.logicalName!==original[index].logicalName||!target.attributes||typeof target.attributes!=='object'||Array.isArray(target.attributes)||Object.hasOwn(target.attributes,primary)||!uuid.test(target.id)||((update||original[index].id!==emptyId)&&target.id!==original[index].id))return true;if(target.id!==emptyId){if(unique.has(target.id.toLowerCase()))return true;unique.add(target.id.toLowerCase());}return false;}))fail('Bulk plugin changed the table/count or an existing target identity.','LocalPluginBulkInput',400);};
 const phase=(stage,records)=>{if(stage!==10)store.pluginInTransaction=true;if(store.pluginPipeline&&store.pluginPipelineActive({entity:mapping.logicalName,operation})){const frame=store.pluginPipeline({entity:mapping.logicalName,operation,stage,targets,previousRecords:previous,records,record:holder,identity,changedAttributes:[...new Set(targets.flatMap(target=>Object.keys(target.attributes??{})))]});if(stage===40)handoffPluginResponse(store,operation,mapping.logicalName,frame,responseToken);}check();};
 try{
  phase(10,[]);phase(20,[]);
  // Preimages retain the original request snapshot. Authorization must see
  // current rows after every stage20 SDK side effect, for every target before
  // the first bulk primary write.
  const writes=targets.map(target=>{
    const values=sdkValueToRecord(target),current=update?store.get(entity,target.id,identity,{skipPluginRead:true}):null;
    if(update&&!current)fail('Bulk target was removed during PreOperation.','NotFound',404);
    authorize(single,update?{...current,...values}:values,current);
    return {target,values};
  });
  const rows=writes.map(({target,values})=>update?store.updateRecord(entity,target.id,values,identity,{coerce:true}):store.createRecord(entity,{...values,...(target.id!==emptyId?{[primary]:target.id}:{})},identity,{coerce:true}));
  holder.bulkIds=rows.map(row=>row[primary]);phase(40,rows);return {rows,ids:holder.bulkIds};
 }finally{store.pluginInTransaction=inherited;}
}
