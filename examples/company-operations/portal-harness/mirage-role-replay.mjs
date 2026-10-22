import {createHash} from 'node:crypto';
import {buildQualificationDomain} from '../portal-security/qualification-domain.mjs';
import {parseExactJson} from 'paqvilo/mirage/lib/exact-numeric.mjs';
const stable=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const hash=value=>createHash('sha256').update(stable(value)).digest('hex');
const guid=value=>typeof value==='string'&&/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(value);
const sorted=values=>[...values].sort();
/** A role-mask label is not evidence. Bind it to actual frozen memberships,
 * authored domain sources and native history for every fragment/page/lane. */
export function validateRoleReplayCell({contract,cell,inputs,identityFor}){
 const {domain,blueprint,schema,catalogue,manifest}=inputs;if(!contract||!domain||!blueprint||!manifest||typeof identityFor!=='function')throw new Error('Role replay requires an explicit frozen domain, manifest, blueprint and actor contract.');
 const rebuilt=buildQualificationDomain({blueprint,schema,catalogue,manifest,witnesses:domain.source?.witnesses});
 if(domain.domainHash!==rebuilt.domainHash||domain.domainHash!==contract.domainHash||domain.roleMaskCount!==4096||domain.businessRoles.length!==12||domain.missingNativeWitnesses.length)throw new Error('Role replay domain does not match its exact frozen source definitions/witnesses.');
 if(!guid(contract.actorId)||!guid(contract.siteId)||typeof contract.campaignDirectory!=='string'||!Array.isArray(contract.auxiliaryRoleIds)||contract.auxiliaryRoleIds.some(id=>!guid(id))||new Set(contract.auxiliaryRoleIds).size!==contract.auxiliaryRoleIds.length)throw new Error('Role replay requires an exact actor/site/campaign and auxiliary membership contract.');
 if(!Number.isInteger(cell.mask)||cell.mask<0||cell.mask>=4096||cell.id!=='m'+cell.mask)throw new Error('A role cell identity must be its exact m<mask> value.');
 const businessIds=domain.businessRoles.map(role=>role.id);if(contract.auxiliaryRoleIds.some(id=>businessIds.includes(id)))throw new Error('Auxiliary memberships overlap the measured business-role domain.');
 const parts=inputs.nativePages??[inputs];if(!Array.isArray(parts)||!parts.length||parts.length>20)throw new Error('Role replay requires a bounded complete native page set.');
 const requests=[],operations=new Set(),runs=new Set(),histories=[];let roles;
 for(const part of parts){const before=part.snapshotBefore,after=part.snapshotAfter,actor=identityFor(before),afterActor=identityFor(after),capture=part.capture,history=part.history;
  if(before?.contactId!==contract.actorId||before?.siteId!==contract.siteId||stable(actor)!==stable(afterActor))throw new Error('Role cell actor/site or memberships changed during the native page.');
  const actualMask=businessIds.reduce((mask,id,bit)=>mask|(actor.roleIds.includes(id)?1<<bit:0),0),aux=actor.roleIds.filter(id=>!businessIds.includes(id));if(actualMask!==cell.mask||stable(sorted(aux))!==stable(sorted(contract.auxiliaryRoleIds)))throw new Error('Role mask does not equal its actual frozen native memberships.');
  for(const role of domain.businessRoles){const native=before.permissions.find(row=>row.powerpagecomponentid===role.id&&row.powerpagecomponenttype===11&&row.statecode===0);if(!native||native.name!==role.name||native._powerpagesiteid_value!==contract.siteId)throw new Error('Measured role definitions do not match their frozen native site source.');}
  if(!capture||!guid(capture.runId)||runs.has(capture.runId)||!history||history.runId!==capture.runId||history.runSummary?.status!=='verified'||!Array.isArray(history.entries))throw new Error('Role cell requires distinct native Runs and their verified history readbacks.');runs.add(capture.runId);
  if(capture.recordingInputs?.run?.pqvd_testrunid!==capture.runId||capture.recordingInputs.run._pqvd_runnercontactid_value!==contract.actorId||capture.recordingInputs.operations?.length!==capture.requests.length)throw new Error('Role proof requires actual pre-query Run and operation readbacks.');
  if(stable(sorted(capture.actorRoles??[]))!==stable(sorted(actor.roles)))throw new Error('Captured portal role claims differ from frozen native membership identities.');
  roles??=actor.roleIds;
  if(history.entries.length!==capture.requests.length)throw new Error('Native role history does not cover its exact physical request set.');
  const entries=new Map(history.entries.map(entry=>[entry.id,entry]));if(entries.size!==history.entries.length)throw new Error('Native role history repeats operation identities.');
  for(const request of capture.requests){const entry=entries.get(request.operationId),summary=entry?.summary,claim=summary?.campaign;
   if(!guid(request.operationId)||operations.has(request.operationId)||entry?.status!=='verified'||summary.runId!==capture.runId||summary.contactId!==contract.actorId||summary.caseId!==request.caseId||summary.lane!==request.lane||summary.page!==(request.page??1)||claim?.domainHash!==contract.domainHash||claim.mask!==cell.mask||claim.directory!==contract.campaignDirectory||claim.page!==(request.page??1)||stable(claim.roleCodes)!==stable(domain.businessRoles.filter((_,bit)=>cell.mask&(1<<bit)).map(role=>role.code)))throw new Error('Native role history does not bind its campaign, mask, actor and physical request.');
   operations.add(request.operationId);requests.push({request,capture});
  }histories.push(hash(history));
 }
 const plans=[...(manifest.cases??[]),...(manifest.stressCases??[]),...(manifest.odataVariants??[]),...(manifest.odataPositiveVariants??[])],expected=new Map();
 for(const plan of plans)for(const fragment of plan.fragments??[plan])for(const lane of plan.queryType==='odata'?['webapi']:['liquid','webapi']){const key=stable([plan.id,fragment.variant??'fetchxml',lane]);if(expected.has(key))throw new Error('Authored role query inventory is ambiguous.');expected.set(key,[]);}
 for(const row of requests){const {request}=row,key=stable([request.caseId,request.variant,request.lane]),pages=expected.get(key);if(!pages||!Number.isInteger(request.page??1)||(request.page??1)<1||(request.page??1)>20||pages.some(row=>(row.request.page??1)===(request.page??1)))throw new Error('Role request inventory contains a foreign or duplicated fragment/page/lane.');pages.push(row);}
 const missing=[];for(const[key,rows]of expected){rows.sort((a,b)=>(a.request.page??1)-(b.request.page??1));if(!rows.length){missing.push({key,page:1});continue;}for(let index=0;index<rows.length;index++){
   const {request,capture}=rows[index],page=request.page??1;if(page!==index+1)throw new Error('Role query page sequence has a gap.');let more=false;
   if(request.lane==='liquid'){const actual=capture.liquidPages?.find(row=>row.operationId===request.operationId);if(!actual)throw new Error('Role page lacks actual Liquid wire.');more=actual.outcome==='success'&&actual.more===true;}
   else{const actual=capture.results?.find(row=>row.operationId===request.operationId);if(!actual)throw new Error('Role page lacks actual HTTP wire.');if(actual.status===200){const body=parseExactJson(actual.body);more=Boolean(body['@odata.nextLink'])||body['@Microsoft.Dynamics.CRM.morerecords']===true;}}
   if(index<rows.length-1&&!more)throw new Error('Role query has a continuation after a terminal native page.');if(index===rows.length-1&&more)missing.push({key,page:page+1});
  }}
 return {verified:true,complete:missing.length===0,scope:'Actual frozen twelve-role membership lattice, exact source catalogue and complete native fragment/page/lane history',domainHash:domain.domainHash,mask:cell.mask,actorId:contract.actorId,siteId:contract.siteId,roleIds:roles,runIds:[...runs],operationIds:[...operations],historySha256:histories,physicalReads:requests.length,missing};
}
