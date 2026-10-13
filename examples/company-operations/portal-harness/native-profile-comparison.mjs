import {queryFingerprint,capturedQueries} from './parity.mjs';
import {canonicalRows,stable} from './core.mjs';
/** Compare physical native requests across recorder profiles. Only complete
 * declared marker literals may differ; generated aliases and all other XML
 * bytes remain significant. Native lane differences are preserved. */
export function compareNativeReadProfiles({baseline,candidate,manifest}) {
 const errors=[],rows=[],planById=new Map([...manifest.cases,...(manifest.stressCases??[])].map(plan=>[plan.id,plan]));
 const index=capture=>{const map=new Map();for(const request of capture.requests){if(!request.authoredFetchXml){errors.push('api-only-query-needs-native-expression-comparison');continue;}const key=[request.caseId,request.lane,request.page??1,queryFingerprint(request.authoredFetchXml).sentinelNormalizedByteHash].join('|');if(map.has(key))errors.push('duplicate-physical-request');map.set(key,request);}return map;};
 const left=index(baseline),right=index(candidate);
 for(const [key,expected]of left){const actual=right.get(key);if(!actual){errors.push('missing-physical-request');rows.push({caseId:expected.caseId,lane:expected.lane,equal:false,reason:'missing'});continue;}
  const events=capture=>capturedQueries(capture.backendEvents.filter(event=>event._pqvd_operationid_value===(capture===baseline?expected:actual).operationId),{operationId:(capture===baseline?expected:actual).operationId});
  const a=events(baseline),b=events(candidate),queries=parts=>parts.queries.filter(query=>query.stage===20&&query.order===9900).map(query=>({artifact:query.artifact,type:query.queryType,hash:query.fingerprint.sentinelNormalizedByteHash}));
  const plan=planById.get(expected.caseId),outcome=(capture,request)=>{if(request.lane==='liquid'){const page=capture.liquidPages.find(page=>page.operationId===request.operationId);return{outcome:page?.outcome,more:page?.more,rows:Array.isArray(page?.rows)?canonicalRows(page.rows,plan):null};}const response=capture.results.find(response=>response.operationId===request.operationId&&response.lane==='webapi');let data;try{data=JSON.parse(response.body);}catch{}return{status:response?.status,code:data?.error?.innererror?.cdscode??data?.error?.code,count:data?.['@odata.count'],rows:Array.isArray(data?.value)?canonicalRows(data.value,plan):null};};
  const queryEqual=!a.errors.length&&!b.errors.length&&stable(queries(a))===stable(queries(b)),outcomeEqual=stable(outcome(baseline,expected))===stable(outcome(candidate,actual));
  rows.push({caseId:expected.caseId,lane:expected.lane,page:expected.page??1,operationId:actual.operationId,queryEqual,outcomeEqual,equal:queryEqual&&outcomeEqual,backendPresent:queries(a).length>0,captureErrors:[...a.errors,...b.errors]});
 }
 if(right.size!==left.size)errors.push('physical-request-count');return{qualified:errors.length===0&&rows.every(row=>row.equal),errors,physicalRequests:rows.length,matching:rows.filter(row=>row.equal).length,backendQueries:rows.filter(row=>row.backendPresent).length,backendlessOutcomes:rows.filter(row=>!row.backendPresent).length,rows};
}
