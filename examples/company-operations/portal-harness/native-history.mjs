import{savePrivateJson}from'./private-journal.mjs';
import{parseExactJson}from'paqvilo/mirage/lib/exact-numeric.mjs';
import{encodeArtifact,decodeArtifact,canonicalRows,sha256,stable}from'./core.mjs';
import{recordedPluginPayloads}from'../plugins/mirage-runtime.mjs';
/** Persist each measured native physical read in its owned operation. Existing
 * final-query events remain the authoritative backend history; no rows deleted. */
export async function persistNativeReadHistory(client,{capture,intents,manifest,journalFile,campaign={}}){
 const backend=recordedPluginPayloads(capture.backendEvents),plans=[];
 for(const intent of intents){const request=capture.requests.find(r=>r.operationId===intent.id);if(!request)throw new Error('Native history request missing.');
  const events=backend.filter(p=>p.operationId===intent.id),liquid=capture.liquidPages.find(p=>p.operationId===intent.id),response=capture.results.find(r=>r.operationId===intent.id&&r.lane==='webapi');let body;try{body=parseExactJson(response?.body);}catch{}
  const executionRequested=intent.lane!=='liquid'||liquid?.outcome!=='results-not-requested';
  const rawRows=intent.lane==='liquid'?(executionRequested?liquid?.rows:undefined):body?.value,rows=Array.isArray(rawRows)?canonicalRows(rawRows,intent.plan):null,query=request.authoredFetchXml??request.authoredRequest;
  const summary={schemaVersion:1,campaign,runId:capture.runId,contactId:intent.operation._pqvd_runnercontactid_value,roles:capture.actorRoles??[],caseId:request.caseId,lane:intent.lane,page:request.page??1,
   executionRequested,outcome:intent.lane==='liquid'?liquid?.outcome:response?.status===200?(Array.isArray(body?.value)?'success':'malformed-response'):'HTTP error',httpStatus:response?.status??null,platformCode:body?.error?.cdscode??body?.error?.innererror?.cdscode??body?.error?.innererror?.code??body?.error?.code??null,
   wireResponse:response?{mime:response.mime??null,body:await encodeArtifact(response.body,response.mime??'application/json')}:null,
   count:rows?.length??null,rows,more:intent.lane==='liquid'?liquid?.more:body?.['@odata.nextLink']?true:body?.['@odata.count']!==undefined?body['@odata.count']!==rows?.length:rows?.length===intent.plan.pageSize,
   authoredSha256:await sha256(query),backendArtifacts:await Promise.all(events.map(async event=>({artifact:event.artifact,stage:event.context?.Stage,order:event.context?.executionOrder,querySha256:event.content?.query?.xml?await sha256(event.content.query.xml):null}))),
   frozenSnapshot:capture.qualification.snapshotComparison,snapshotHashes:capture.qualification.snapshotHashes??null,
   manifestSha256:manifest.manifestHash??null,sourceSha256:manifest.sourceHash??null,
   siteComponentsSha256:capture.qualification.siteComponentsSha256??null,archiveSha256:capture.archive?.sha256??null,
   registrationSha256:capture.qualification.registrationSha256,sourceStable:capture.qualification.sourcesStable};
  const encoded=await encodeArtifact(stable(summary)),authored=await encodeArtifact(query,intent.plan.queryType==='odata'?'text/uri-list':'application/xml'),xml=liquid?.effectiveFetchXml?await encodeArtifact(liquid.effectiveFetchXml,'application/xml'):null;
  if(encoded.length>65536||authored.length>262144||xml?.length>262144)throw new Error('Native operation history exceeds declared memo bounds; preserve private capture and split artifacts before persisting.');
  plans.push({id:intent.id,summary,body:{pqvd_authoredquery:authored,pqvd_physicalqueryhash:await sha256(query),pqvd_clientsummary:encoded,...(xml?{pqvd_liquidxml:xml}:{}),pqvd_clientfinishedat:new Date().toISOString()},status:'planned'});
 }
 const journal={schemaVersion:1,kind:'NativeReadHistory',runId:capture.runId,startedAt:new Date().toISOString(),entries:plans};let saveTail=Promise.resolve();const save=()=>{const snapshot=structuredClone(journal);return saveTail=saveTail.then(()=>savePrivateJson(journalFile,snapshot));};await savePrivateJson(journalFile,journal,{exclusive:true});
 let offset=0;const outcomes=await Promise.allSettled(Array.from({length:Math.min(4,plans.length)},async()=>{while(offset<plans.length){const entry=plans[offset++],endpoint=`pqvd_testoperations(${entry.id})`,before=await client.get(endpoint);if(before._pqvd_runid_value!==capture.runId||!before['@odata.etag'])throw new Error('Native history ownership/version preflight failed.');entry.status='pending';await save();await client.request(endpoint,{method:'PATCH',body:entry.body,ifMatch:before['@odata.etag']});const actual=await client.get(endpoint);if(await decodeArtifact(actual.pqvd_clientsummary)!==stable(entry.summary)||actual.pqvd_physicalqueryhash!==entry.body.pqvd_physicalqueryhash)throw new Error('Native history readback checksum mismatch.');entry.status='verified';await save();}}));
 await saveTail;const failure=outcomes.find(result=>result.status==='rejected');if(failure)throw failure.reason;
 const completed=manifest.choices?.pqvd_runstate?.Completed;if(!Number.isInteger(completed))throw new Error('Native history requires the verified run-state choice values.');
 const runEndpoint=`pqvd_testruns(${capture.runId})`,run=await client.get(runEndpoint),actor=intents[0]?.operation._pqvd_runnercontactid_value;
 if(!actor||run._pqvd_runnercontactid_value!==actor||!run['@odata.etag'])throw new Error('Native run history ownership/version preflight failed.');
 const runSummary={schemaVersion:1,kind:'native-read-campaign-index',runId:capture.runId,campaign,contactId:actor,roles:capture.actorRoles??[],manifestHash:manifest.manifestHash??null,sourceHash:manifest.sourceHash??null,datasetVersion:manifest.datasetVersion??null,
  snapshotHashes:capture.qualification.snapshotHashes??null,registrationSha256:capture.qualification.registrationSha256,siteComponentsSha256:capture.qualification.siteComponentsSha256??null,archive:capture.archive??null,
  parityQualification:'pending-exact-Mirage-replay',operations:await Promise.all(plans.map(async entry=>({operationId:entry.id,caseId:entry.summary.caseId,lane:entry.summary.lane,page:entry.summary.page,summarySha256:await sha256(stable(entry.summary))})))};
 const summaryText=stable(runSummary);if(summaryText.length>262144)throw new Error('Native run history summary exceeds the declared memo bound.');
 journal.runSummary={status:'pending',sha256:await sha256(summaryText)};await save();const finishedAt=new Date().toISOString();await client.request(runEndpoint,{method:'PATCH',body:{pqvd_summaryjson:summaryText,pqvd_finishedat:finishedAt,pqvd_runstate:completed},ifMatch:run['@odata.etag']});
 const actualRun=await client.get(runEndpoint);if(actualRun.pqvd_summaryjson!==summaryText||actualRun.pqvd_runstate!==completed)throw new Error('Native run history readback checksum/state mismatch.');
 journal.runSummary.status='verified';journal.finishedAt=finishedAt;await save();return{runId:capture.runId,operations:plans.length,runSummarySha256:journal.runSummary.sha256,journalFile};
}
