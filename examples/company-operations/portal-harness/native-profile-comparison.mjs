import {queryFingerprint,capturedQueries} from './parity.mjs';
import {canonicalRows,stable} from './core.mjs';
import {createHash} from 'node:crypto';
import {parseExactJson} from 'paqvilo/mirage/lib/exact-numeric.mjs';
/** Normalize only complete OData string literals containing the two declared
 * operation markers. Other strings, option order and query text stay exact. */
export function profileAuthoredRequestFingerprint(request) {
 if(request.authoredFetchXml)return queryFingerprint(request.authoredFetchXml).sentinelNormalizedByteHash;
 if(request.lane!=='webapi'||typeof request.url!=='string')throw new Error('Native profile request has no witnessed authored query.');
 const url=new URL(request.url,'http://127.0.0.1'),parameters=[...url.searchParams].map(([name,value])=>[name,name==='$filter'?value.replace(/'(?:[^']|'')*'/g,literal=>{
  const value=literal.slice(1,-1).replaceAll("''","'");
  if(/^CO-OP:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value))return "'CO-OP:{operation}'";
  if(/^CO-UTC:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))return "'CO-UTC:{time}'";
  return literal;
 }):value]);
 return createHash('sha256').update(stable({pathname:url.pathname,parameters})).digest('hex');
}
/** Compare physical native requests across recorder profiles. Only complete
 * declared marker literals may differ; generated aliases and all other XML
 * bytes remain significant. Native lane differences are preserved. */
export function compareNativeReadProfiles({baseline,candidate,manifest,finalObserverOrder=9900}) {
 if(!Number.isSafeInteger(finalObserverOrder)||finalObserverOrder<1)throw new Error('Explicit final observer order must be a positive integer.');
 const errors=[],rows=[],planById=new Map([...(manifest.cases??[]),...(manifest.stressCases??[]),...(manifest.odataVariants??[]),...(manifest.odataPositiveVariants??[])].map(plan=>[plan.id,plan]));
 const index=capture=>{const map=new Map();for(const request of capture.requests){let fingerprint;try{fingerprint=profileAuthoredRequestFingerprint(request);}catch{errors.push('missing-authored-query');continue;}const key=[request.caseId,request.lane,request.page??1,fingerprint].join('|');if(map.has(key))errors.push('duplicate-physical-request');map.set(key,request);}return map;};
 const left=index(baseline),right=index(candidate);
 for(const [key,expected]of left){const actual=right.get(key);if(!actual){errors.push('missing-physical-request');rows.push({caseId:expected.caseId,lane:expected.lane,equal:false,reason:'missing'});continue;}
  const events=capture=>capturedQueries(capture.backendEvents.filter(event=>event._pqvd_operationid_value===(capture===baseline?expected:actual).operationId),{operationId:(capture===baseline?expected:actual).operationId});
  const a=events(baseline),b=events(candidate),queries=parts=>{const final=parts.queries.filter(query=>query.stage===20&&query.order===finalObserverOrder);if(parts.queries.length&&!final.length)errors.push('missing-final-observer');return final.map(query=>({artifact:query.artifact,type:query.queryType,hash:query.fingerprint.sentinelNormalizedByteHash}));};
  const plan=planById.get(expected.caseId),outcome=(capture,request)=>{if(request.lane==='liquid'){const page=capture.liquidPages.find(page=>page.operationId===request.operationId);if(!page||typeof page.outcome!=='string')errors.push('missing-liquid-outcome');return{outcome:page?.outcome,more:page?.more,rows:Array.isArray(page?.rows)&&plan?canonicalRows(page.rows,plan):null};}const response=capture.results.find(response=>response.operationId===request.operationId&&response.lane==='webapi');let data;try{data=parseExactJson(response.body);}catch{errors.push('missing-webapi-outcome');}if(!Number.isInteger(response?.status))errors.push('missing-webapi-status');return{status:response?.status,code:data?.error?.cdscode??data?.error?.innererror?.cdscode??data?.error?.innererror?.code??data?.error?.code,count:data?.['@odata.count'],rows:Array.isArray(data?.value)&&plan?canonicalRows(data.value,plan):null};};
  if(!plan)errors.push('missing-source-query-plan');
  const queryEqual=!a.errors.length&&!b.errors.length&&stable(queries(a))===stable(queries(b)),outcomeEqual=stable(outcome(baseline,expected))===stable(outcome(candidate,actual));
  rows.push({caseId:expected.caseId,lane:expected.lane,page:expected.page??1,operationId:actual.operationId,queryEqual,outcomeEqual,equal:queryEqual&&outcomeEqual,backendPresent:queries(a).length>0,captureErrors:[...a.errors,...b.errors]});
 }
 if(right.size!==left.size)errors.push('physical-request-count');return{qualified:errors.length===0&&rows.every(row=>row.equal),errors,physicalRequests:rows.length,matching:rows.filter(row=>row.equal).length,backendQueries:rows.filter(row=>row.backendPresent).length,backendlessOutcomes:rows.filter(row=>!row.backendPresent).length,rows};
}
