export const guid = value => String(value).replace(/[{}]/g,'').toLowerCase();
export const escapeXml = value => String(value).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
export const stable = value => JSON.stringify(sortObject(value));
function sortObject(value) {return Array.isArray(value) ? value.map(sortObject) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,sortObject(value[k])])) : value;}
export async function sha256(value) {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(typeof value === 'string' ? value : stable(value))))].map(b=>b.toString(16).padStart(2,'0')).join('');}
export async function encodeArtifact(text,contentType='application/json') {
  const bytes=new TextEncoder().encode(text);let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
  return stable({artifactFormat:'paqvilo-utf8-base64-v1',contentType,byteLength:bytes.length,payloadSha256:await sha256(text),base64:btoa(binary)});
}
export async function decodeArtifact(text) {
  let envelope;try{envelope=JSON.parse(text);}catch{return text;}
  if(envelope?.artifactFormat!=='paqvilo-utf8-base64-v1')return text;
  if(typeof envelope.base64!=='string'||!Number.isSafeInteger(envelope.byteLength)||envelope.byteLength<0)throw new Error('Invalid encoded artifact metadata.');
  const binary=atob(envelope.base64),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));if(bytes.length!==envelope.byteLength)throw new Error('Encoded artifact byte length mismatch.');
  const decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(await sha256(decoded)!==envelope.payloadSha256)throw new Error('Decoded artifact checksum mismatch.');return decoded;
}
export function authoredQuery(plan, operation, page=1) {
  if (!/^[a-f0-9-]{36}$/.test(guid(operation.pqvd_testoperationid)) || operation.pqvd_markeroperation !== `CO-OP:${guid(operation.pqvd_testoperationid)}` || !/^CO-UTC:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(operation.pqvd_markerutc)) throw new Error('Missing/invalid server operation markers; OperationIntentGuard is required.');
  if (page<1 || page>20) throw new Error('Paging bound exceeded.');
  if(plan.fetchXml.includes('{{runId}}')&&!/^[a-f0-9-]{36}$/.test(guid(operation.runId)))throw new Error('Owned run binding missing.');
  return plan.fetchXml.replaceAll('{{runId}}',escapeXml(guid(operation.runId))).replaceAll('{{pageSize}}',String(plan.pageSize)).replaceAll('{{page}}',String(page)).replaceAll('{{markerUtc}}',escapeXml(operation.pqvd_markerutc)).replaceAll('{{markerOperation}}',escapeXml(operation.pqvd_markeroperation));
}
export function odataRequest(plan, operation) {
  authoredQuery(plan,operation); // The same immutable marker validation applies to the native variant.
  const literal=value=>`'${String(value).replaceAll("'","''")}'`;
  const filter=`(${plan.fixtureIds.map(id=>`${plan.primaryId} eq ${guid(id)}`).join(' or ')}) and (${plan.primaryName} eq null or (${plan.primaryName} ne ${literal(operation.pqvd_markerutc)} and ${plan.primaryName} ne ${literal(operation.pqvd_markeroperation)}))`;
  return `/_api/${plan.entitySet}?$select=${plan.fields.map(f=>f.source).join(',')}&$filter=${encodeURIComponent(filter)}&$orderby=${plan.primaryId}&$count=true`;
}
export function normalize(value, field) {
  if (value === undefined) return null; // Documented FetchXML null attributes are omitted by API.
  if (value === null) return null;
  if (field.type === 'guid') return guid(typeof value==='object' ? value.id ?? value.Id : value);
  if (field.type === 'integer' || field.type === 'choice') {
    const literal=typeof value==='object'?value.value:value,parts=numericParts(literal);
    if(!parts||parts.scale!==0)throw new Error(`Invalid integer ${field.name}`);
    const n=Number(parts.coefficient);return Number.isSafeInteger(n)?n:parts.coefficient.toString();
  }
  if (['decimal','money','double'].includes(field.type)) {
    const parts=numericParts(typeof value==='object'?value.value:value),precision=Number(field.precision??0);
    if(!parts||!Number.isInteger(precision)||precision<0||precision>28)throw new Error(`Invalid decimal ${field.name}`);
    let coefficient=parts.coefficient;
    if(parts.scale>precision){const divisor=10n**BigInt(parts.scale-precision),negative=coefficient<0n,absolute=negative?-coefficient:coefficient;
      coefficient=(absolute/divisor+(absolute%divisor*2n>=divisor?1n:0n))*(negative?-1n:1n);
    }else coefficient*=10n**BigInt(precision-parts.scale);
    const negative=coefficient<0n,digits=(negative?-coefficient:coefficient).toString().padStart(precision+1,'0');
    return (negative?'-':'')+(precision?digits.slice(0,-precision)+'.'+digits.slice(-precision):digits);
  }
  if (field.type === 'dateonly') {const text=String(value);if (!/^\d{4}-\d\d-\d\d/.test(text)) throw new Error(`Invalid DateOnly ${field.name}`);return text.slice(0,10);}
  if (field.type === 'datetime') return new Date(value).toISOString();
  if (field.type === 'boolean') {
    if(value===true||value===false)return value;
    if(value===1||value===0)return value===1;
    if(typeof value==='string'&&/^(?:true|false|0|1)$/i.test(value))return /^(?:true|1)$/i.test(value);
    throw new Error(`Invalid boolean ${field.name}`);
  }
  return String(value);
}
function numericParts(value) {
  const text=String(value);if(text.length>160)return null;
  const match=/^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);if(!match)return null;
  const exponent=Number(match[4]??0);if(Math.abs(exponent)>128)return null;
  let coefficient=BigInt((match[1]==='-'?'-':'')+match[2]+(match[3]??'')),scale=(match[3]?.length??0)-exponent;
  if(scale<0){coefficient*=10n**BigInt(-scale);scale=0;}
  while(scale>0&&coefficient%10n===0n){coefficient/=10n;scale--;}
  return {coefficient,scale};
}
export function canonicalRows(rows, plan) {
  return rows.map(row=>Object.fromEntries(plan.fields.map(field=>[field.name,normalize(row[field.name] ?? row[`_${field.source}_value`],field)]))).sort((a,b)=>stable(a).localeCompare(stable(b)));
}
export function compareResults(left,right) {
  if (!left.complete || !right.complete) return 'incomplete';
  if (left.outcome!==right.outcome) return 'different-outcome';
  if (left.outcome!=='success') return 'unsupported';
  if (left.rows.length!==right.rows.length) return 'different-counts';
  if (stable(left.rows)!==stable(right.rows)) return stable(left.ids)!==stable(right.ids) ? 'different-IDs' : 'different-fields';
  return 'equal';
}
export function diffRows(previous,current,plan) {
  const selectedIds=plan.fields.filter(f=>f.type==='guid'&&!f.aggregate).map(f=>f.name);
  const keys=selectedIds.length?selectedIds:plan.fields.filter(f=>!f.aggregate).map(f=>f.name);
  const index=rows=>{const map=new Map();for(const row of rows){const key=stable(Object.fromEntries(keys.map(k=>[k,row[k]])));map.set(key,[...(map.get(key)||[]),row]);}return map;};
  const old=index(previous),now=index(current),added=[],removed=[],changed=[],multiplicity=[];
  for(const key of new Set([...old.keys(),...now.keys()])) {
    const left=old.get(key)||[],right=now.get(key)||[];
    if(!left.length){added.push(...right);continue;}if(!right.length){removed.push(...left);continue;}
    if(left.length!==right.length)multiplicity.push({rowKey:JSON.parse(key),previous:left.length,current:right.length});
    const l=left.slice().sort((a,b)=>stable(a).localeCompare(stable(b))),r=right.slice().sort((a,b)=>stable(a).localeCompare(stable(b)));
    for(let i=0;i<Math.min(l.length,r.length);i++) {const fields=plan.fields.map(f=>f.name).filter(name=>stable(l[i][name])!==stable(r[i][name])).map(name=>({field:name,previous:l[i][name],current:r[i][name]}));if(fields.length)changed.push({rowKey:JSON.parse(key),fields});}
  }
  return {added,removed,changed,multiplicity};
}
export function assessScenario(scenario, observations, manifest) {
  return scenario.expected.filter(e=>e.privilege==='Read').map(expected=> {
    const observation=observations.find(o=>o.caseId===manifest.cases.find(c=>c.table===expected.table)?.id);
    if (!observation || !observation.complete || observation.outcome!=='success') return {...expected,actual:'unknown',verdict:'incomplete'};
    const actual=observation.ids.includes(guid(expected.id));return {...expected,actual,verdict:actual===expected.allowed?'pass':'fail'};
  });
}
export function laneOutcome(result) {
  const pages=(result?.pages||[]).map(page=>{let error;try{error=JSON.parse(page.body||'null')?.error;}catch{}return {httpStatus:page.httpStatus??null,portalCode:error?.code||null,platformCode:error?.cdscode||error?.innererror?.code||null,error:page.error||null};});
  return {outcome:result?.outcome??'missing',complete:result?.complete===true,pages};
}
export function diffObservation(previous,current,plan) {
  const priorOutcome=laneOutcome(previous),currentOutcome=laneOutcome(current),outcomeDifference=stable(priorOutcome)!==stable(currentOutcome);
  return {priorOutcome,currentOutcome,outcomeVerdict:outcomeDifference?'different':'equal',rowCompleteness:previous?.complete&&current?.complete?'complete':'incomplete',...diffRows(previous?.rows||[],current?.rows||[],plan)};
}
export function pageComplete({more, rowCount, pageSize, nextLink}) {return !nextLink && (more===false || more!=='true' && more!==true && rowCount<pageSize);}
export function parseLiquid(text, plan, DOMParserClass=globalThis.DOMParser) {
  const doc=new DOMParserClass().parseFromString(text,'application/xml');
  if(doc.querySelector('parsererror')) throw new Error('Liquid endpoint returned invalid XML (possibly a query error or sign-in page).');
  const root=doc.documentElement;if(root.nodeName!=='co-test-response') throw new Error('Unexpected Liquid response envelope.');
  if(root.getAttribute('outcome')!=='success') throw Object.assign(new Error(root.querySelector('error')?.textContent || `Liquid ${root.getAttribute('outcome')}; no successful records collection.`),{effectiveFetchXml:root.querySelector('effective-fetchxml')?.textContent||null,rawLiquidResponse:text});
  const rows=[...root.querySelectorAll('records > record')].map(record=>Object.fromEntries([...record.querySelectorAll('field')].map(f=>[f.getAttribute('name'),f.getAttribute('null')?.toLowerCase()==='true'?null:f.textContent])));
  const more=root.querySelector('paging')?.getAttribute('more')?.toLowerCase();
  return {rows,more:more==='true'?true:more==='false'?false:null,cookie:root.querySelector('cookie')?.textContent || null,authoredFetchXml:root.querySelector('authored-fetchxml')?.textContent,effectiveFetchXml:root.querySelector('effective-fetchxml')?.textContent,contactId:guid(root.getAttribute('contact-id')),roles:[...root.querySelectorAll('roles > role')].map(r=>r.textContent),caseId:root.getAttribute('case-id'),operationId:guid(root.getAttribute('operation-id')),datasetVersion:root.getAttribute('dataset-version')};
}
export function splitPayload(text,max=240000) {const parts=[];for(let i=0;i<text.length;i+=max){let end=Math.min(text.length,i+max);if(end<text.length && /[\uD800-\uDBFF]/.test(text[end-1])) end--;parts.push(text.slice(i,end));i=end-max;}return parts.length?parts:[''];}
