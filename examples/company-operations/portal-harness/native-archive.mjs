import {readFile,writeFile} from 'node:fs/promises';
import {gzip,gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {snapshotHash} from './native-capture.mjs';
const compress=promisify(gzip),expand=promisify(gunzip),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const guid=id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const canonical=rows=>rows.map(row=>Object.fromEntries(Object.entries(row).filter(([key,value])=>!key.startsWith('@')&&key!=='versionnumber'&&value!==null))).sort((a,b)=>snapshotHash(a).localeCompare(snapshotHash(b)));
async function readOwnedRows(client,intent){
 const run=await client.get(`pqvd_testruns(${intent.runId})`);
 if(run._pqvd_runnercontactid_value!==intent.actor||run.pqvd_runkey!==intent.entries[0].body.pqvd_runkey)throw new Error('Archive refuses foreign run identity.');
 const operations=await client.list(`pqvd_testoperations?$filter=_pqvd_runid_value eq ${intent.runId}`);
 const expected=intent.entries[1].ids.slice().sort(),found=operations.map(row=>row.pqvd_testoperationid).sort();
 if(JSON.stringify(expected)!==JSON.stringify(found)||operations.some(row=>row._pqvd_runnercontactid_value!==intent.actor))throw new Error('Archive refuses missing/foreign operation identities.');
 const xml=`<fetch><entity name="pqvd_pluginevent"><all-attributes/><link-entity name="pqvd_testoperation" from="pqvd_testoperationid" to="pqvd_operationid"><filter><condition attribute="pqvd_runid" operator="eq" value="${intent.runId}"/></filter></link-entity></entity></fetch>`;
 const events=await client.list(`pqvd_pluginevents?fetchXml=${encodeURIComponent(xml)}`);
 if(events.some(row=>!expected.includes(row._pqvd_operationid_value)))throw new Error('Archive refuses foreign event provenance.');
 // FetchXML omits null columns and can omit versionnumber. Freeze direct
 // record representations and ETags before archival for safe conditional cleanup.
 const direct=async(table,rows,primary)=>{const result=[];for(let offset=0;offset<rows.length;offset+=8)result.push(...await Promise.all(rows.slice(offset,offset+8).map(row=>client.get(`${table}(${row[primary]})`))));return result;};
 const directOperations=await direct('pqvd_testoperations',operations,'pqvd_testoperationid'),directEvents=await direct('pqvd_pluginevents',events,'pqvd_plugineventid');
 const all=[['pqvd_testruns',run.pqvd_testrunid,run],...directOperations.map(row=>['pqvd_testoperations',row.pqvd_testoperationid,row]),...directEvents.map(row=>['pqvd_pluginevents',row.pqvd_plugineventid,row])];
 if(all.some(([, ,row])=>!row?.['@odata.etag']))throw new Error('Owned archival requires exact native record versions.');
 return {run:canonical([run])[0],operations:canonical(directOperations),events:canonical(directEvents),rowVersions:Object.fromEntries(all.map(([table,id,row])=>[`${table}(${id})`,row['@odata.etag']]))};
}
/** Archival and cleanup are restricted to newly SDK-owned, verified intent
 * journals. Historical discoveries or run IDs alone never authorize deletion. */
export async function archiveOwnedRun(client,{intentJournalFile,captureFile,archiveFile,receiptFile}) {
 const intent=JSON.parse(await readFile(intentJournalFile,'utf8'));
 if(intent.source!=='SDK-created immutable recording intents; measured reads are portal requests'||!guid(intent.runId)||intent.entries[0]?.status!=='created'||intent.entries[1]?.status!=='verified'||intent.entries[1].ids.some(id=>!guid(id)))throw new Error('Only a completed owned campaign intent journal can be archived.');
 const captureBytes=await readFile(captureFile),capture=JSON.parse(captureBytes);
 if(capture.runId!==intent.runId)throw new Error('Capture/run ownership mismatch.');
 const rows=await readOwnedRows(client,intent),envelope={schemaVersion:1,kind:'OwnedNativeCampaignArchive',runId:intent.runId,intent,capture,rows};
 const bytes=Buffer.from(JSON.stringify(envelope)),packed=await compress(bytes,{level:9});
 await writeFile(archiveFile,packed,{flag:'wx'});
 const readback=await readFile(archiveFile);if(sha(await expand(readback))!==sha(bytes))throw new Error('Archive readback checksum mismatch.');
 const receipt={schemaVersion:1,kind:envelope.kind,runId:intent.runId,actor:intent.actor,archiveFile,archiveSha256:sha(readback),contentSha256:sha(bytes),captureSha256:sha(captureBytes),rowHash:snapshotHash(rows),bytes:bytes.length,gzipBytes:packed.length,operationCount:rows.operations.length,eventCount:rows.events.length,archivedAt:new Date().toISOString()};
 await writeFile(receiptFile,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});return receipt;
}
export async function cleanupArchivedRun(client,{receiptFile,journalFile,resume=false}) {
 const receipt=JSON.parse(await readFile(receiptFile,'utf8')),packed=await readFile(receipt.archiveFile);
 if(receipt.kind!=='OwnedNativeCampaignArchive'||sha(packed)!==receipt.archiveSha256)throw new Error('Cleanup requires a verified immutable archive.');
 const bytes=await expand(packed);if(sha(bytes)!==receipt.contentSha256)throw new Error('Archived content checksum mismatch.');
 const archive=JSON.parse(bytes);if(archive.runId!==receipt.runId||archive.intent.runId!==receipt.runId)throw new Error('Archived provenance mismatch.');
 if(!resume){const current=await readOwnedRows(client,archive.intent);if(snapshotHash(current)!==receipt.rowHash)throw new Error('Native owned rows changed after archival; cleanup refused.');}
 const plans=[...archive.rows.events.map(row=>({table:'pqvd_pluginevents',id:row.pqvd_plugineventid,row})),...archive.rows.operations.map(row=>({table:'pqvd_testoperations',id:row.pqvd_testoperationid,row})),{table:'pqvd_testruns',id:receipt.runId,row:archive.rows.run}];
 if(plans.some(plan=>!guid(plan.id)))throw new Error('Cleanup refuses unsafe record identity.');
 const journal=resume?JSON.parse(await readFile(journalFile,'utf8')):{schemaVersion:1,kind:'OwnedNativeCampaignCleanup',runId:receipt.runId,receiptFile,archiveSha256:receipt.archiveSha256,startedAt:new Date().toISOString(),entries:plans.map(({table,id})=>({table,id,status:'planned'}))};
 if(journal.kind!=='OwnedNativeCampaignCleanup'||journal.runId!==receipt.runId||journal.archiveSha256!==receipt.archiveSha256||JSON.stringify(journal.entries.map(({table,id})=>({table,id})))!==JSON.stringify(plans.map(({table,id})=>({table,id}))))throw new Error('Cleanup resume provenance mismatch.');
 if(!resume)await writeFile(journalFile,JSON.stringify(journal,null,2)+'\n',{flag:'wx'});const save=()=>writeFile(journalFile,JSON.stringify(journal,null,2)+'\n');
 for(const entry of journal.entries){
  const endpoint=`${entry.table}(${entry.id})`,actual=await client.optional(endpoint);
  if(!actual){if(!['pending','deleted'].includes(entry.status))throw new Error('Owned row disappeared before cleanup reached it.');entry.status='deleted';await save();continue;}
  if(entry.status==='deleted'||snapshotHash(canonical([actual])[0])!==snapshotHash(plans.find(plan=>plan.table===entry.table&&plan.id===entry.id).row)||actual['@odata.etag']!==archive.rows.rowVersions[endpoint])throw new Error('Owned row changed during cleanup; deletion refused.');
  entry.status='pending';await save();await client.request(endpoint,{method:'DELETE',ifMatch:actual['@odata.etag']});if(await client.optional(endpoint))throw new Error('Cleanup deletion readback failed.');entry.status='deleted';await save();
 }
 journal.finishedAt=new Date().toISOString();await save();return journal;
}
