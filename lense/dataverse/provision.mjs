import fs from 'node:fs/promises';
import path from 'node:path';
import { compileManifest, digest, validateManifest } from './manifest.mjs';
import { metadataId } from './client.mjs';
import { privateJson, pacExecutable, runProcess } from './connection.mjs';
import {parseXmlDocument} from '../../mirage/lib/fetchxml-engine.mjs';

// Dataverse adds a savedqueryid and reserializes metadata XML on publish.
// Normalize syntax only; preserve every field, filter, join, value and order.
export function metadataXml(source){const tree=parseXmlDocument(source);const normalize=(node,isRoot=false)=>({name:node.name,attrs:Object.fromEntries(Object.entries(node.attrs).filter(([key])=>!(isRoot&&node.name==='fetch'&&key==='savedqueryid')).sort(([a],[b])=>a.localeCompare(b))),text:node.text.trim()?node.text:'',children:node.children.map(n=>normalize(n))});return JSON.stringify(normalize(tree,true));}

const TYPES={table:1,'table-reference':1,column:2,choice:9,relationship:10,key:14,form:60,view:26};
const guid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escape=value=>value.replaceAll("'","''");
function normalizeExpected(actual, expected, key='') {
  if (expected===null || typeof expected!=='object') {
    if(typeof actual==='string'&&typeof expected==='string'&&['formxml','fetchxml','layoutxml'].includes(key)){try{return metadataXml(actual);}catch{return actual;}}
    if (typeof actual==='string' && typeof expected==='string' && ['SchemaName','LogicalName','Name'].includes(key)) return actual.toLowerCase();
    return actual;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return null;
    if (key==='Attributes') return expected.map(e=>normalizeExpected(actual.find(a=>a.SchemaName?.toLowerCase()===e.SchemaName?.toLowerCase()),e));
    if (key==='LocalizedLabels') return expected.map(e=>normalizeExpected(actual.find(a=>a.LanguageCode===e.LanguageCode),e));
    if (key==='Options') return actual.length===expected.length ? expected.map(e=>normalizeExpected(actual.find(a=>a.Value===e.Value),e)) : actual;
    if (key==='KeyAttributes') return [...actual].sort();
    return actual;
  }
  const result={};
  for (const [property,value] of Object.entries(expected)) {
    if (property==='@odata.type' || property==='CanBeChanged' || property==='ManagedPropertyLogicalName') continue;
    if (property==='GlobalOptionSet@odata.bind') result[property]=actual?.GlobalOptionSet?.Name ? `/GlobalOptionSetDefinitions(Name='${actual.GlobalOptionSet.Name}')` : actual?.[property];
    else if (property.endsWith('AssociatedMenuConfiguration')) result[property]={Behavior:actual?.[property]?.Behavior};
    else result[property]=normalizeExpected(actual?.[property],value,property);
  }
  return result;
}
export function compatible(actual, desired) {
  if (!actual) return false;
  if (desired['@odata.type'] && actual['@odata.type'] && actual['@odata.type'].replace(/^#/,'')!==desired['@odata.type'].replace(/^#/,'')) return false;
  return JSON.stringify(normalizeExpected(actual,desired))===JSON.stringify(normalizeExpected(desired,desired));
}

async function one(client, route) {
  const rows=await client.list(route);
  if(rows.length>1) throw new Error('Metadata identity resolved to multiple components.');
  return rows[0]??null;
}

export async function existingComponent(client, action) {
  const b=action.body;
  if(action.kind==='publisher') return one(client,`publishers?$filter=uniquename eq '${escape(b.uniquename)}'`);
  if(action.kind==='solution') return one(client,`solutions?$filter=uniquename eq '${escape(b.uniquename)}'`);
  if(action.kind==='choice') return client.optional(`GlobalOptionSetDefinitions(Name='${b.Name}')/Microsoft.Dynamics.CRM.OptionSetMetadata`);
  if(action.kind==='table'||action.kind==='table-reference') {
    const table=await client.optional(`EntityDefinitions(LogicalName='${action.table}')`);
    if(table&&action.kind==='table') table.Attributes=[await client.get(`EntityDefinitions(LogicalName='${action.table}')/Attributes(LogicalName='${b.PrimaryNameAttribute}')`)];
    return table;
  }
  if(action.kind==='column') {
    const cast=b['@odata.type'];
    const attribute=await client.optional(`EntityDefinitions(LogicalName='${action.table}')/Attributes(LogicalName='${action.column}')`);
    if(!attribute) return null;
    if(attribute['@odata.type']&&attribute['@odata.type'].replace(/^#/,'')!==cast&&attribute['@odata.type'].replace(/^#/,'')!=='Microsoft.Dynamics.CRM.AttributeMetadata') return attribute;
    return client.get(`EntityDefinitions(LogicalName='${action.table}')/Attributes(LogicalName='${action.column}')/${cast}${b['GlobalOptionSet@odata.bind']?'?$expand=GlobalOptionSet':cast==='Microsoft.Dynamics.CRM.BooleanAttributeMetadata'?'?$expand=OptionSet':''}`);
  }
  if(action.kind==='relationship') {
    const relation=await one(client,`RelationshipDefinitions?$filter=SchemaName eq '${b.SchemaName}'`);
    if(relation&&b.Lookup) relation.Lookup=await client.optional(`EntityDefinitions(LogicalName='${b.ReferencingEntity}')/Attributes(LogicalName='${b.Lookup.SchemaName.toLowerCase()}')/Microsoft.Dynamics.CRM.LookupAttributeMetadata`);
    return relation;
  }
  if(action.kind==='key') return one(client,`EntityDefinitions(LogicalName='${action.table}')/Keys?$filter=SchemaName eq '${b.SchemaName}'`);
  if(action.kind==='form') return client.optional(`systemforms(${action.id})`);
  if(action.kind==='view') return client.optional(`savedqueries(${action.id})`);
  throw new Error('Unknown provisioning component kind.');
}

export async function planManifest(manifest, {client}={}) {
  manifest=validateManifest(manifest);
  const compiled=compileManifest(manifest), actions=[],missingTables=new Set();
  let publisherId;
  if(client) {
    for(const table of manifest.tables) {
      const found=await client.optional(`EntityDefinitions(LogicalName='${table.name}')`);
      if(!found&&table.existing) throw new Error(`Required existing table ${table.name} is absent.`);
      if(!found) missingTables.add(table.name);
    }
  }
  for(const action of compiled.actions) {
    const existing=client && !(['column','key'].includes(action.kind)&&missingTables.has(action.table)) ? await existingComponent(client,action) : null;
    if(action.kind==='publisher') publisherId=existing?.publisherid;
    const wrongPublisher=action.kind==='solution'&&existing&&(!publisherId||existing._publisherid_value?.toLowerCase()!==publisherId.toLowerCase());
    const status=existing ? (compatible(existing,action.body)&&!wrongPublisher?'exists':'drift') : 'create';
    actions.push({...action,status,...(existing?{existingId:existing.MetadataId??existing.publisherid??existing.solutionid??existing.formid??existing.savedqueryid}:{}),...(action.kind==='key'&&existing?{keyStatus:existing.EntityKeyIndexStatus}: {})});
  }
  return {...compiled,environmentUrl:client?.origin??null,mode:client?'remote-read-only':'offline',actions,summary:{create:actions.filter(a=>a.status==='create').length,exists:actions.filter(a=>a.status==='exists').length,drift:actions.filter(a=>a.status==='drift').length}};
}

export async function applyManifest(input, {client, journalFile, expectedOrganisationId, onProgress=()=>{}}) {
  const manifest=validateManifest(input);
  const identity=await client.verify(expectedOrganisationId);
  const plan=await planManifest(manifest,{client});
  if(plan.summary.drift) throw new Error(`Existing metadata has ${plan.summary.drift} incompatible component(s). Inspect a remote plan; additive provisioning will not overwrite them.`);
  const journal={schemaVersion:1,manifestHash:plan.manifestHash,environmentUrl:client.origin,identity,startedAt:new Date().toISOString(),state:'Running',entries:[]};
  if(journalFile) await privateJson(journalFile,journal,true);
  let publisherId;
  const solutionIds=new Map();
  const choiceIds=new Map();
  const include=async (id,type,solution,root=false)=>{
    const solutionId=solutionIds.get(solution);
    if(!guid.test(solutionId??'')) throw new Error('Solution identity is unavailable.');
    const included=await client.list(`solutioncomponents?$select=objectid,componenttype,rootcomponentbehavior&$filter=_solutionid_value eq ${solutionId} and objectid eq ${id} and componenttype eq ${type}`);
    if(!included.length) await client.request('AddSolutionComponent',{method:'POST',body:{ComponentId:id,ComponentType:type,SolutionUniqueName:solution,AddRequiredComponents:false,...(root?{DoNotIncludeSubcomponents:true}:{})}});
  };
  try {
    for(const planned of plan.actions) {
      journal.pending = planned.key;
      if(journalFile) await privateJson(journalFile,journal);
      // Re-read each identity before its write; preflight snapshots can become stale.
      const current=await existingComponent(client,planned);
      if(current&&!compatible(current,planned.body)) throw new Error(`Metadata changed while applying ${planned.key}. Re-plan before continuing.`);
      if(planned.kind==='solution'&&current&&current._publisherid_value?.toLowerCase()!==publisherId?.toLowerCase()) throw new Error('Solution publisher changed while applying.');
      let componentId=current?.MetadataId??current?.publisherid??current?.solutionid??current?.formid??current?.savedqueryid;
      let status='exists';
      if(!current) {
        if(planned.kind==='table-reference') throw new Error('Required existing table disappeared.');
        const body=structuredClone(planned.body);
        // Name resolves reliably for reads; bind writes use the server MetadataId.
        // Some Dataverse builds reject Name-key bindings with a GUID parse error.
        const binding=body['GlobalOptionSet@odata.bind']?.match(/^\/GlobalOptionSetDefinitions\(Name='([^']+)'\)$/);
        if(binding){const id=choiceIds.get(binding[1]);if(!guid.test(id??''))throw new Error('Global choice identity is unavailable.');body['GlobalOptionSet@odata.bind']=`/GlobalOptionSetDefinitions(${id})`;}
        if(planned.kind==='solution') { if(!publisherId||!guid.test(publisherId)) throw new Error('Publisher identity is missing.'); body['publisherid@odata.bind']=`/publishers(${publisherId})`; }
        const result=await client.request(planned.route,{method:'POST',body,solution:planned.solution});
        componentId=planned.id??metadataId(result);
        status='created';
        if(planned.kind==='relationship'&&planned.body.Lookup)await completeLookupAudit(client,planned.body.ReferencingEntity,planned.body.Lookup.SchemaName.toLowerCase(),planned.solution);
      }
      if(planned.kind==='publisher') publisherId=componentId;
      if(planned.kind==='solution') solutionIds.set(planned.body.uniquename,componentId);
      if(planned.kind==='choice') choiceIds.set(planned.body.Name,componentId);
      if(TYPES[planned.kind]) {
        if(!guid.test(componentId??'')) throw new Error('Invalid component ID; reconcile before continuing.');
        await include(componentId,TYPES[planned.kind],planned.solution,['table','table-reference'].includes(planned.kind));
        if(planned.kind==='table') {
          const primaryName=planned.body.PrimaryNameAttribute;
          const primary=await client.get(`EntityDefinitions(LogicalName='${planned.table}')/Attributes(LogicalName='${primaryName}')`);
          if(!guid.test(primary.MetadataId??'')) throw new Error('Primary-name metadata identity is unavailable; reconcile before exporting.');
          await include(primary.MetadataId,2,planned.solution);
        }
        if(planned.kind==='relationship'&&planned.body.Lookup){const lookup=await client.get(`EntityDefinitions(LogicalName='${planned.body.ReferencingEntity}')/Attributes(LogicalName='${planned.body.Lookup.SchemaName.toLowerCase()}')`);if(!guid.test(lookup.MetadataId??''))throw new Error('Lookup metadata identity is unavailable; reconcile before exporting.');await include(lookup.MetadataId,2,planned.solution);}
      }
      const entry={key:planned.key,status,componentId,bodyHash:digest(planned.body),finishedAt:new Date().toISOString()};
      journal.entries.push(entry);
      delete journal.pending;
      if(journalFile) await privateJson(journalFile,journal);
      onProgress(entry);
    }
    journal.solutionRoots=await scopeSolutionRoots(manifest,client,{onProgress:async event=>{journal.rootScoping??=[];journal.rootScoping.push(event);if(journalFile)await privateJson(journalFile,journal);}});
    journal.state='Created';
    journal.finishedAt=new Date().toISOString();
    if(journalFile) await privateJson(journalFile,journal);
    return journal;
  } catch(error) {
    journal.state=error.code==='UNKNOWN_COMMIT'?'UnknownCommit':'Interrupted';
    journal.error={code:error.code??'PROVISIONING_STOPPED',message:error.message};
    if(journalFile) await privateJson(journalFile,journal);
    throw error;
  }
}

// Creating metadata with SolutionUniqueName can automatically add a table root
// with IncludeSubcomponents. That later pulls another solution's forms/columns
// into this export. Keep explicitly added subcomponents and narrow only known
// table roots through the supported AddSolutionComponent action.
export async function scopeSolutionRoots(input,client,{onProgress=()=>{}}={}){
  const manifest=validateManifest(input),known=new Map(),changes=[];
  for(const table of manifest.tables){const actual=await client.get(`EntityDefinitions(LogicalName='${table.name}')?$select=MetadataId,LogicalName`);if(!guid.test(actual.MetadataId??''))throw new Error('Table identity unavailable for solution scoping.');known.set(actual.MetadataId.toLowerCase(),table.name);}
  const solutionIds=new Map(),scopes=[],declared=[];
  for(const action of compileManifest(manifest).actions.filter(a=>TYPES[a.kind])){const current=await existingComponent(client,action);if(!current||!compatible(current,action.body))throw new Error('Declared metadata must exist unchanged before solution scoping.');declared.push({action,current});}
  const add=async(id,type,solution)=>client.request('AddSolutionComponent',{method:'POST',body:{ComponentId:id,ComponentType:type,SolutionUniqueName:solution,AddRequiredComponents:false,...(type===1?{DoNotIncludeSubcomponents:true}:{})}});
  for(const solution of manifest.solutions){const rows=await client.list(`solutions?$select=solutionid&$filter=uniquename eq '${solution.uniqueName}'`);if(rows.length!==1)throw new Error('Solution identity unavailable for table-root scoping.');const sid=rows[0].solutionid;solutionIds.set(solution.uniqueName,sid);const route=`solutioncomponents?$select=solutioncomponentid,objectid,componenttype,rootcomponentbehavior&$filter=_solutionid_value eq ${sid}`,before=await client.list(route),roots=before.filter(row=>row.componenttype===1&&row.rootcomponentbehavior===0);
    if(roots.some(root=>!known.has(root.objectid?.toLowerCase())))throw new Error('Undeclared table root would include unrelated subcomponents; scoping refused.');
    scopes.push({solution,sid,route,before,roots});
  }
  for(const {solution,sid,route,before,roots} of scopes){
    if(!roots.length)continue;
    // The action does not narrow an existing IncludeAll root. Removing only its
    // solution membership leaves the Dataverse table/data intact. Save every
    // explicit component first; the caller's journal makes interruption reviewable.
    await onProgress({state:'before-membership-replacement',solution:solution.uniqueName,components:before});
    for(const root of roots){await client.request('RemoveSolutionComponent',{method:'POST',body:{SolutionComponent:{'@odata.type':'Microsoft.Dynamics.CRM.solutioncomponent',solutioncomponentid:root.objectid},ComponentType:1,SolutionUniqueName:solution.uniqueName}});await add(root.objectid,1,solution.uniqueName);const after=(await client.list(route)).find(row=>row.componenttype===1&&row.objectid?.toLowerCase()===root.objectid.toLowerCase());if(after?.rootcomponentbehavior!==1)throw new Error('Dataverse did not retain explicit table-root scoping.');changes.push({solution:solution.uniqueName,table:known.get(root.objectid.toLowerCase()),before:0,after:1});}
    for(const component of before.filter(row=>row.componenttype!==1)){const present=await client.list(`solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${sid} and objectid eq ${component.objectid} and componenttype eq ${component.componenttype}`);if(!present.length)await add(component.objectid,component.componenttype,solution.uniqueName);}
    await onProgress({state:'roots-scoped',solution:solution.uniqueName});
  }
  // IncludeAll roots can mask absent explicit membership. Restore the declared
  // metadata after narrowing; never create/alter a table, column or business row.
  for(const {action,current} of declared){const id=current.MetadataId??current.formid??current.savedqueryid,type=TYPES[action.kind],sid=solutionIds.get(action.solution);if(!guid.test(id??''))throw new Error('Declared component identity unavailable during solution scoping.');const present=await client.list(`solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${sid} and objectid eq ${id} and componenttype eq ${type}`);if(!present.length)await add(id,type,action.solution);if(action.kind==='table'){const primary=await client.get(`EntityDefinitions(LogicalName='${action.table}')/Attributes(LogicalName='${action.body.PrimaryNameAttribute}')`);if(!guid.test(primary.MetadataId??''))throw new Error('Primary-name component unavailable during solution scoping.');const included=await client.list(`solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${sid} and objectid eq ${primary.MetadataId} and componenttype eq 2`);if(!included.length)await add(primary.MetadataId,2,action.solution);}}
  for(const relation of manifest.relationships.filter(r=>r.kind==='oneToMany')){const attribute=await client.get(`EntityDefinitions(LogicalName='${relation.child}')/Attributes(LogicalName='${relation.lookup.name}')`),sid=solutionIds.get(relation.solution);if(!guid.test(attribute.MetadataId??''))throw new Error('Lookup component unavailable during solution scoping.');const included=await client.list(`solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${sid} and objectid eq ${attribute.MetadataId} and componenttype eq 2`);if(!included.length)await add(attribute.MetadataId,2,relation.solution);}
  await onProgress({state:'declared-memberships-restored',changedRoots:changes.length});
  return{changedRoots:changes.length,changes};
}

async function completeLookupAudit(client,table,column,solution){
  const attribute=await client.get(`EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='${column}')/Microsoft.Dynamics.CRM.LookupAttributeMetadata`);
  if(attribute.IsAuditEnabled?.Value===true)return false;
  if(attribute.IsAuditEnabled?.CanBeChanged===false||!guid.test(attribute.MetadataId??''))throw new Error('Declared lookup audit setting cannot be completed.');
  const body=structuredClone(attribute);for(const key of Object.keys(body))if(key.startsWith('@odata.')&&key!=='@odata.type')delete body[key];
  body['@odata.type']='Microsoft.Dynamics.CRM.LookupAttributeMetadata';
  body.IsAuditEnabled.Value=true;
  await client.request(`EntityDefinitions(LogicalName='${table}')/Attributes(${attribute.MetadataId})`,{method:'PUT',body,solution,mergeLabels:true});
  const actual=await client.get(`EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='${column}')/Microsoft.Dynamics.CRM.LookupAttributeMetadata`);
  if(actual.IsAuditEnabled?.Value!==true)throw new Error('Dataverse did not retain the lookup audit setting.');
  return true;
}
export async function completeLookupAuditing(input,client){const m=validateManifest(input);let checked=0,updated=0;for(const r of m.relationships.filter(r=>r.kind==='oneToMany')){checked++;if(await completeLookupAudit(client,r.child,r.lookup.name,r.solution))updated++;}return{checkedLookups:checked,updatedLookups:updated};}

const xmlEscape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export async function publishManifest(input, client) {
  const manifest=validateManifest(input);
  const entities=manifest.tables.map(t=>`<entity>${xmlEscape(t.name)}</entity>`).join('');
  const choices=manifest.choices.map(c=>`<optionset>${xmlEscape(c.name)}</optionset>`).join('');
  await client.request('PublishXml',{method:'POST',body:{ParameterXml:`<importexportxml><entities>${entities}</entities><optionsets>${choices}</optionsets></importexportxml>`}});
  return {publishedTables:manifest.tables.length,publishedChoices:manifest.choices.length};
}

export async function checkKeys(input,client) {
  const manifest=validateManifest(input), keys=[];
  for(const table of manifest.tables) for(const key of table.keys) {
    const actual=await one(client,`EntityDefinitions(LogicalName='${table.name}')/Keys?$filter=SchemaName eq '${key.name}'`);
    keys.push({table:table.name,key:key.name,status:actual?.EntityKeyIndexStatus??'Missing',asyncJob:actual?.AsyncJob??null});
  }
  return {ready:keys.every(k=>k.status==='Active'),keys};
}

export async function exportSolution({client,solutionName,zipFile,unpackFolder}) {
  if(!/^[a-z][a-z0-9_]*$/i.test(solutionName)) throw new Error('Invalid solution name.');
  const result=await client.request('ExportSolution',{method:'POST',body:{SolutionName:solutionName,Managed:false}});
  const encoded=result.data?.ExportSolutionFile;
  if(typeof encoded!=='string'||!encoded) throw new Error('Export did not return a solution file.');
  const zip=Buffer.from(encoded,'base64');
  if(zip.subarray(0,2).toString()!=='PK') throw new Error('Export is not a ZIP archive.');
  await fs.mkdir(path.dirname(path.resolve(zipFile)),{recursive:true});
  await fs.writeFile(zipFile,zip,{flag:'wx',mode:0o600});
  if(unpackFolder) {
    const result=await runProcess(pacExecutable(),['solution','unpack','--zipfile',path.resolve(zipFile),'--folder',path.resolve(unpackFolder),'--packagetype','Unmanaged']);
    if(result.code!==0||result.timedOut||/^\s*Error:/im.test(result.stdout+'\n'+result.stderr)) throw new Error('PAC unpack failed; exported ZIP preserved. PAC output withheld.');
  }
  return {solutionName,zipFile:path.resolve(zipFile),zipHash:digest(zip),unpackFolder:unpackFolder?path.resolve(unpackFolder):null};
}
