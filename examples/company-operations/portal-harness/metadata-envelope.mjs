import {createHash} from 'node:crypto';
import {parseExactJson} from 'paqvilo/mirage/lib/exact-numeric.mjs';

const guid=value=>typeof value==='string'&&/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(value);
const numeric=value=>typeof value==='string'&&/^[0-9]{1,32}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f\d]{64}$/.test(value);
const origin=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&url.href===url.origin+'/';}catch{return false;}};
const stable=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const digest=value=>createHash('sha256').update(stable(value)).digest('hex');

/** Official, read-only metadata functions. These observe the current Dataverse
 * timestamp independently of any measured portal query or expected response. */
export async function readNativeMetadataEnvelope(client,{tableName='account'}={}){
 if(typeof client?.get!=='function'||!origin(client.origin)||typeof tableName!=='string'||!/^[a-z][a-z\d_]{0,99}$/.test(tableName))throw new Error('Metadata observation requires an explicit HTTPS client and bounded logical table.');
 const query={Properties:{AllProperties:false,PropertyNames:['LogicalName']},Criteria:{FilterOperator:'And',Conditions:[{PropertyName:'LogicalName',ConditionOperator:'Equals',Value:{Type:'System.String',Value:tableName}}]}};
 const startedAt=new Date().toISOString(),before=await client.get('RetrieveTimestamp()');
 const metadata=await client.get('RetrieveMetadataChanges(Query=@q)?@q='+encodeURIComponent(JSON.stringify(query)));
 const after=await client.get('RetrieveTimestamp()'),stamp=metadata?.ServerVersionStamp;
 if(!numeric(before?.Timestamp)||!numeric(after?.Timestamp)||typeof stamp!=='string'||stamp.length>256||/[\r\n]/.test(stamp)||!/^\d{1,32}!/.test(stamp)||!Array.isArray(metadata.EntityMetadata)||metadata.EntityMetadata.length!==1||metadata.EntityMetadata[0].LogicalName!==tableName)throw new Error('Independent metadata observation is absent, malformed or not the requested single table.');
 const answer={schemaVersion:1,kind:'NativeMetadataEnvelope',environmentOrigin:client.origin,startedAt,finishedAt:new Date().toISOString(),tableName,timestampBefore:before.Timestamp,serverVersionStamp:stamp,timestampAfter:after.Timestamp,stable:before.Timestamp===after.Timestamp,serverStampMatchesTimestamp:stamp.split('!')[0]===before.Timestamp};
 return {...answer,sha256:digest(answer),qualification:'Current Dataverse metadata source only; portal cache equivalence remains independently observed'};
}

/** An independent, actor-owned Run control observes the portal's cached
 * metadata envelope. It is deliberately separate from measured case output. */
export async function readPortalMetadataEnvelope({readPortal,portalOrigin,runRecord,actorId,roleIds,siteSourceHash,registrationHash,snapshotHash}){
 const runId=runRecord?.pqvd_testrunid;
 if(typeof readPortal!=='function'||!origin(portalOrigin)||!guid(runId)||!guid(actorId)||runRecord._pqvd_runnercontactid_value!==actorId||!Array.isArray(roleIds)||roleIds.some(id=>!guid(id))||new Set(roleIds).size!==roleIds.length||![siteSourceHash,registrationHash,snapshotHash].every(sha))throw new Error('Portal metadata control requires an explicit HTTPS portal, actual actor-owned Run and exact source/identity witness.');
 const requestPath=`/_api/pqvd_testruns(${runId})?$select=pqvd_testrunid`,startedAt=new Date().toISOString(),response=await readPortal(requestPath);
 if(response?.status!==200||typeof response.body!=='string'||Buffer.byteLength(response.body)>16384)throw new Error('Independent portal metadata control did not return a bounded successful response.');
 let body;try{body=parseExactJson(response.body);}catch{throw new Error('Independent portal metadata control returned invalid JSON.');}
 const version=body?.['@Microsoft.Dynamics.CRM.globalmetadataversion'];
 if(body.pqvd_testrunid!==runId||!numeric(version)||body.value!==undefined||body.error!==undefined)throw new Error('Portal metadata control identity or metadata envelope is invalid.');
 const answer={schemaVersion:1,kind:'PortalCacheMetadataEnvelope',portalOrigin,startedAt,finishedAt:new Date().toISOString(),requestPath,runId,actorId,roleIds:[...roleIds].sort(),siteSourceHash,registrationHash,snapshotHash,version,status:200,bodySha256:createHash('sha256').update(response.body).digest('hex')};
 return {...answer,sha256:digest(answer),qualification:'Independent portal cache control for this frozen actor/source cohort; not a universal Dataverse timestamp derivation'};
}

export function compareMetadataEnvelopeWindow({nativeBefore,nativeAfter,portalBefore,portalAfter}){
 const validNative=row=>row?.kind==='NativeMetadataEnvelope'&&row.schemaVersion===1&&origin(row.environmentOrigin)&&row.stable===true&&numeric(row.timestampBefore)&&row.timestampBefore===row.timestampAfter;
 const validPortal=row=>row?.kind==='PortalCacheMetadataEnvelope'&&row.schemaVersion===1&&origin(row.portalOrigin)&&numeric(row.version)&&guid(row.runId)&&guid(row.actorId)&&[row.siteSourceHash,row.registrationHash,row.snapshotHash].every(sha)&&Array.isArray(row.roleIds)&&row.roleIds.every(guid);
 const unsigned=row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['sha256','qualification'].includes(key)));
 if(![nativeBefore,nativeAfter].every(validNative)||![portalBefore,portalAfter].every(validPortal)||[nativeBefore,nativeAfter,portalBefore,portalAfter].some(row=>row.sha256!==digest(unsigned(row))))throw new Error('Metadata window has missing or altered independent control receipts.');
 const ordered=[nativeBefore,portalBefore,portalAfter,nativeAfter].flatMap(row=>[row.startedAt,row.finishedAt]);
 if(ordered.some((time,index)=>typeof time!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time)||!Number.isFinite(Date.parse(time))||index>0&&Date.parse(time)<Date.parse(ordered[index-1])))throw new Error('Metadata controls do not bracket the measured window in chronological order.');
 const binding=row=>[row.portalOrigin,row.runId,row.actorId,row.roleIds,row.siteSourceHash,row.registrationHash,row.snapshotHash];
 const sameCohort=stable(binding(portalBefore))===stable(binding(portalAfter)),nativeStable=nativeBefore.environmentOrigin===nativeAfter.environmentOrigin&&nativeBefore.tableName===nativeAfter.tableName&&nativeBefore.timestampAfter===nativeAfter.timestampBefore,portalStable=portalBefore.version===portalAfter.version;
 return {schemaVersion:1,sameCohort,nativeStable,portalStable,qualified:sameCohort&&nativeStable&&portalStable,portalVersion:portalStable?portalBefore.version:null,dataverseTimestamp:nativeStable?nativeBefore.timestampAfter:null,portalMatchesCurrentTimestamp:nativeStable&&portalStable&&portalBefore.version===nativeBefore.timestampAfter,scope:'Independent fixed-cohort portal cache envelope, with separately bracketed current Dataverse metadata timestamps'};
}
