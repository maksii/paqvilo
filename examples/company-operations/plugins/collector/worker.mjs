import path from 'node:path';
import {fileURLToPath} from 'node:url';
// Run independently from the Dataverse business transaction. Azure App Service managed identity only.
import{createHash}from'node:crypto';import{DataverseClient}from'paqvilo/dataverse';import{identityToken,blobRequest}from'./collector.mjs';
import{validateEnvelope,chunks}from'./protocol.mjs';
const env=process.env.CO_DATAVERSE_URL;const parsed=new URL(env);if(parsed.protocol!=='https:'||parsed.pathname!=='/'||!parsed.hostname.endsWith('.dynamics.com'))throw new Error('Configured Dataverse environment required.');
const client=new DataverseClient({environmentUrl:env,token:()=>identityToken(`${parsed.origin}/`)});
const stableGuid=(value)=>{const h=createHash('sha256').update(value).digest('hex');return`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
export{chunks};
export async function persist(envelope){
 const{capture}=validateEnvelope(envelope);const context=capture.context;const operation=await client.optional(`pqvd_testoperations(${envelope.operationId})?$select=pqvd_testoperationid,_pqvd_runid_value`);if(!operation?._pqvd_runid_value)return{state:'UnmatchedOrQuarantined.RetainedInBlob'};const pieces=chunks(envelope.payload);
 for(let index=0;index<pieces.length;index++){const id=stableGuid(`${envelope.operationId}/${envelope.eventKey}/${index+1}`);const old=await client.optional(`pqvd_pluginevents(${id})?$select=pqvd_payloadhash,pqvd_partcount`);if(old){if(old.pqvd_payloadhash!==envelope.payloadHash||old.pqvd_partcount!==pieces.length)throw new Error('ImmutableEventConflict');continue;}
 const row={pqvd_plugineventid:id,pqvd_name:`${capture.artifact} ${capture.spanId}`, 'pqvd_operationid@odata.bind':`/pqvd_testoperations(${envelope.operationId})`,pqvd_eventkey:envelope.eventKey,pqvd_partnumber:index+1,pqvd_partcount:pieces.length,pqvd_source:183270001,pqvd_artifacttype:capture.artifact,pqvd_capturetime:capture.captureTime??envelope.collectorTime,pqvd_message:context.MessageName,pqvd_stage:context.Stage,pqvd_mode:context.Mode,pqvd_executionorder:context.executionOrder,pqvd_depth:context.Depth,pqvd_isintransaction:context.IsInTransaction,pqvd_backenduserid:context.UserId,pqvd_initiatinguserid:context.InitiatingUserId,pqvd_correlationid:context.CorrelationId,pqvd_requestid:context.RequestId,pqvd_platformoperationid:context.OperationId,pqvd_spanid:capture.spanId,pqvd_parentspanid:capture.parentSpanId,pqvd_contenttype:'application/json',pqvd_payloadtext:pieces[index],pqvd_payloadhash:envelope.payloadHash,pqvd_provenance:'AzureCollector.DurableReceipt'};await client.request('pqvd_pluginevents',{method:'POST',body:row});}
 await client.request(`pqvd_testoperations(${envelope.operationId})`,{method:'PATCH',body:{pqvd_capturestate:183270001,pqvd_backendlastat:new Date().toISOString(),pqvd_collectorreference:`${envelope.operationId}/${envelope.eventKey}`,pqvd_serversummary:JSON.stringify({captureMode:'DurableCollector',durableReceipt:true,dataversePersisted:true,complete:false,receiptId:`${envelope.operationId}/${envelope.eventKey}`,missingArtifactReconciliation:'Runner manifest required'})}});return{state:'Persisted',parts:pieces.length};
}
// Explicit receipt argument avoids blindly processing unrelated blobs and supports replay after power loss.
async function main(receiptId) {
 if(!/^[a-f0-9-]{36}\/[a-f0-9]{64}$/.test(receiptId))throw new Error('Expected operation/event receipt ID.');
 const receipt=await blobRequest(`events/${receiptId}.json`);
 if(!receipt.ok)throw new Error('ReceiptUnavailable');
 console.log(JSON.stringify(await persist(await receipt.json())));
}
if(process.argv[2]&&process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main(process.argv[2]).catch(error=>{
  const code=['DATAVERSE_HTTP_ERROR','READ_FAILED','UNKNOWN_COMMIT'].includes(error?.code)?error.code:'WORKER_FAILED';
  const status=Number.isInteger(error?.status)&&error.status>=100&&error.status<=599?error.status:null;
  console.error(JSON.stringify({error:'CollectorWorkerFailed',code,status}));
  process.exitCode=1;
 });
}
