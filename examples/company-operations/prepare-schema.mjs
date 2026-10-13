import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from 'paqvilo/dataverse';
import {extendReferenceSchema} from './portal-security/reference-projections.mjs';
import {parseArgs} from 'node:util';
const {values:args}=parseArgs({options:{out:{type:'string'}}});

const project=path.dirname(fileURLToPath(import.meta.url));
const specDirectory=path.resolve(project,'../../docs/design');
const documents=await Promise.all(['company-operations-demo.md','power-pages-permission-test-harness.md','dataverse-plugin-observation.md'].map(name=>fs.readFile(path.join(specDirectory,name),'utf8')));
const [core,harness,plugins]=documents;
const section=(doc,title)=>{const start=doc.indexOf('## '+title+'\n');if(start<0)throw new Error('Missing specification section '+title);const end=doc.indexOf('\n## ',start+3);return doc.slice(start,end<0?undefined:end);};
const refs=text=>[...text.matchAll(/`([a-zA-Z][a-zA-Z0-9_]*)`/g)].map(m=>m[1]);
const rows=text=>text.split('\n').filter(line=>line.startsWith('| ')).map(line=>line.split('|').slice(1,-1).map(cell=>cell.trim()));
const coreSolution='PaqviloCompanyOperationsCore',supportSolution='PaqviloPermissionTestSupport',evidenceSolution='PaqviloPluginEvidence',pluginSolution='PaqviloBehaviorPlugins';
const human=name=>name.replace(/^pqvd_/,'').replace(/id$/,'').replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());
const choices=[];
for(const [source,solution] of [[section(core,'Choices and twelve roles'),coreSolution],[section(harness,'Persistent history and disposable probe schema'),supportSolution],[section(plugins,'Evidence schema and metadata').split('Create three independent global choices')[1].split('`pqvd_lane` uses')[0],evidenceSolution]]) {
  for(const row of rows(source)) if(row.length===2&&/^`pqvd_\w+`$/.test(row[0])) {
    const name=refs(row[0])[0];choices.push({name,label:human(name),solution,options:row[1].split(',').map((label,i)=>({value:183270000+i,label:label.trim()}))});
  }
}
if(choices.length!==26) throw new Error('Choice inventory changed; revalidate specification conversion.');
const lookupFields=new Map(),tables=[];
const choiceAliases={pqvd_issuecondition:'pqvd_condition',pqvd_returncondition:'pqvd_condition',pqvd_lane:'pqvd_testlane',pqvd_source:'pqvd_eventsource',pqvd_samplechoice:'pqvd_operation',pqvd_samplemultichoice:'pqvd_engagementkind'};
const defaults={pqvd_membershipstate:'Pending',pqvd_accessstate:'Pending',pqvd_employmentstate:'Draft',pqvd_assignmentstate:'Planned',pqvd_equipmentstate:'Stock',pqvd_workstate:'New',pqvd_checkresult:'Not run',pqvd_capturestate:'Pending'};
function parseColumns(table,text,solution) {
  const columns=[];
  const pattern=/`(pqvd_\w+)`\s+(Text\(\d+\)|Multiline\(\d+\)|L\([^)]+\)|Integer(?:\([^)]*\))?|Boolean|Choice(?:\([^)]*\))?|MultiSelect\([^)]+\)|Decimal(?:\([^)]*\))?|Money(?:\([^)]*\))?|DateOnly|Date|Time)(!)?/g;
  for(const match of text.matchAll(pattern)) {
    const [name,definition,mandatory]=match.slice(1);if(name==='pqvd_name') continue;
    const column={name,label:human(name),required:mandatory?'required':'none'};
    if(definition.startsWith('L(')) {lookupFields.set(table+'.'+name,{...column,target:definition.slice(2,-1),solution});continue;}
    if(definition.startsWith('Text(')||definition.startsWith('Multiline(')) Object.assign(column,{type:definition.startsWith('Text')?'string':'memo',maxLength:Number(definition.match(/\d+/)[0])});
    else if(definition.startsWith('Choice')||definition.startsWith('MultiSelect')) {
      const choice=definition.match(/\((pqvd_\w+)\)/)?.[1]??choiceAliases[name]??name;Object.assign(column,{type:definition.startsWith('MultiSelect')?'multichoice':'choice',choice});
      if(defaults[name]) {const option=choices.find(c=>c.name===choice)?.options.find(o=>o.label===defaults[name]);if(!option)throw new Error('Missing declared default '+name);column.default=option.value;}
    } else if(definition==='Boolean') Object.assign(column,{type:'boolean',default:false});
    else if(['Date','DateOnly','Time'].includes(definition)) Object.assign(column,{type:'datetime',behavior:definition==='Time'?'UserLocal':'DateOnly'});
    else if(definition.startsWith('Integer')) {const range=definition.match(/\((-?\d+)\.\.(-?\d+)\)/);Object.assign(column,{type:'integer',min:range?Number(range[1]):name==='pqvd_floor'?-2147483648:0,max:range?Number(range[2]):2147483647});}
    else if(definition.startsWith('Money')) Object.assign(column,{type:'money',min:0,max:100000000000,precision:2,precisionSource:name==='pqvd_samplemoney'?0:2});
    else if(definition.startsWith('Decimal')) Object.assign(column,{type:'decimal',min:['pqvd_measuredvalue','pqvd_sampledecimal'].includes(name)?-1000000:0,max:name==='pqvd_ftefraction'?1:name==='pqvd_weeklyhours'?168:1000000,precision:['pqvd_measuredvalue','pqvd_sampledecimal'].includes(name)?4:2});
    else throw new Error('Unsupported specification field '+table+'.'+name);
    if(solution!==tables.find(t=>t.name===table)?.solution&&tables.some(t=>t.name===table)) column.solution=solution;
    columns.push(column);
  }
  return columns;
}
for(const [source,solution] of [[section(core,'Tables columns and keys'),coreSolution],[section(harness,'Persistent history and disposable probe schema'),supportSolution],[section(plugins,'Evidence schema and metadata'),evidenceSolution]]) {
  for(const row of rows(source)) if(/^`\w+` \/ `\w+`$/.test(row[0])) {
    const [name,entitySetName]=refs(row[0]),existing=!name.startsWith('pqvd_');
    const table={name,entitySetName,solution,...(existing?{existing:true,existingColumns:name==='account'?['accountnumber']:[]}:{label:human(name),pluralLabel:human(entitySetName),ownership:name==='pqvd_chainnode'?'user':'organization',primaryName:{name:'pqvd_name',label:'Name',maxLength:160,required:'required'}}),columns:parseColumns(name,row[1],solution),keys:[]};
    tables.push(table);
  }
}
if(tables.length!==28||tables.filter(t=>!t.existing).length!==25) throw new Error('Table inventory changed.');
const relationships=[];
function relationship(name,parent,child,lookup,solution) {
  const field=lookupFields.get(child+'.'+lookup);if(!field||field.target!==parent) throw new Error('Lookup mismatch '+name);
  if(child==='pqvd_testoperation'&&['pqvd_runid','pqvd_runnercontactid'].includes(lookup)) field.required='none';
  relationships.push({name,kind:'oneToMany',parent,child,solution,...(['account','contact'].includes(parent)?{cascade:{Merge:'Cascade'}}:{}),lookup:{name:lookup,label:field.label,required:field.required}});
  if(name==='pqvd_equipment_crudprobes')relationships.at(-1).cascade={Delete:'RemoveLink',Assign:'NoCascade',Share:'NoCascade',Unshare:'NoCascade',Reparent:'NoCascade',Merge:'NoCascade'};
}
for(const row of rows(section(core,'Single target relationships and cascade settings'))) if(row.length===4&&refs(row[0])[0]?.startsWith('pqvd_')) relationship(...row.map(cell=>refs(cell)[0]),coreSolution);
for(const row of rows(section(core,'Choices and twelve roles'))) if(row.length===4&&/^`[A-Z]+`$/.test(row[0])) {
  const [code]=refs(row[0]),[principal]=refs(row[2]);lookupFields.set('pqvd_accesspermission.'+principal,{name:principal,label:human(principal),required:'none',target:'contact',solution:coreSolution});relationship('pqvd_contact_access_'+code.toLowerCase(),'contact','pqvd_accesspermission',principal,coreSolution);
}
for(const row of rows(section(core,'Access permission projections'))) if(/^`pqvd_access_/.test(row[0])) {
  const [name]=refs(row[0]),[parent,child]=refs(row[1]),intersectColumns=refs(row[2]);relationships.push({name,kind:'manyToMany',parent,child,solution:coreSolution,intersectName:name,intersectColumns});
}
for(const [name,parent,child,lookup,solution] of [
  ['pqvd_contact_testruns','contact','pqvd_testrun','pqvd_runnercontactid',supportSolution],['pqvd_testrun_baselines','pqvd_testrun','pqvd_testrun','pqvd_baselinerunid',supportSolution],['pqvd_testrun_results','pqvd_testrun','pqvd_testresult','pqvd_runid',supportSolution],['pqvd_contact_crudprobes','contact','pqvd_crudprobe','pqvd_ownercontactid',supportSolution],['pqvd_testrun_crudprobes','pqvd_testrun','pqvd_crudprobe','pqvd_runid',supportSolution],
  ['pqvd_equipment_crudprobes','pqvd_equipment','pqvd_crudprobe','pqvd_equipmentid',supportSolution],
  ['pqvd_testrun_operations','pqvd_testrun','pqvd_testoperation','pqvd_runid',evidenceSolution],['pqvd_contact_testoperations','contact','pqvd_testoperation','pqvd_runnercontactid',evidenceSolution],['pqvd_testoperation_events','pqvd_testoperation','pqvd_pluginevent','pqvd_operationid',evidenceSolution],['pqvd_testoperation_chainnodes','pqvd_testoperation','pqvd_chainnode','pqvd_operationid',evidenceSolution],['pqvd_chainnode_children','pqvd_chainnode','pqvd_chainnode','pqvd_parentnodeid',evidenceSolution],['pqvd_contact_chainnodes','contact','pqvd_chainnode','pqvd_samplecontactid',evidenceSolution],
]) relationship(name,parent,child,lookup,solution);
relationships.push({name:'pqvd_chainnode_peers',kind:'manyToMany',parent:'pqvd_chainnode',child:'pqvd_chainnode',solution:evidenceSolution,intersectName:'pqvd_chainnodepeer',intersectColumns:['pqvd_chainnodeidone','pqvd_chainnodeidtwo']});
for(const row of rows(section(plugins,'Evidence schema and metadata'))) {
  if(row[0]==='`pqvd_testresult`') {tables.find(t=>t.name==='pqvd_testresult').columns.push(...parseColumns('pqvd_testresult',row[1],pluginSolution));relationship('pqvd_testoperation_results','pqvd_testoperation','pqvd_testresult','pqvd_operationid',pluginSolution);}
  if(row[0]==='`pqvd_crudprobe`') {tables.find(t=>t.name==='pqvd_crudprobe').columns.push(...parseColumns('pqvd_crudprobe',row[1],pluginSolution));relationship('pqvd_testoperation_probes','pqvd_testoperation','pqvd_crudprobe','pqvd_activeoperationid',pluginSolution);}
  if(row[0]==='`pqvd_equipment`') {tables.find(t=>t.name==='pqvd_equipment').columns.push(...parseColumns('pqvd_equipment',row[1],pluginSolution));relationship('pqvd_testrun_canaryequipments','pqvd_testrun','pqvd_equipment','pqvd_canaryrunid',pluginSolution);}
}
const keyColumns={
  pqvd_ak_currencyreference_code:['pqvd_code'],pqvd_ak_currencyreference_currency:['pqvd_systemcurrencyid'],
  pqvd_ak_account_number:['accountnumber'],pqvd_ak_contact_personcode:['pqvd_personcode'],pqvd_ak_accessrole_code:['pqvd_code'],pqvd_ak_accesspermission_number:['pqvd_number'],pqvd_ak_accesspermission_scope:['pqvd_granteecontactid','pqvd_scopeaccountid','pqvd_roleid','pqvd_scopekey'],pqvd_ak_orgcontact_code:['pqvd_code'],pqvd_ak_orgcontact_member:['pqvd_accountid','pqvd_contactid'],pqvd_ak_department_code:['pqvd_accountid','pqvd_code'],pqvd_ak_employment_number:['pqvd_number'],pqvd_ak_employmentterms_employment:['pqvd_employmentid'],pqvd_ak_site_code:['pqvd_accountid','pqvd_code'],pqvd_ak_building_code:['pqvd_siteid','pqvd_code'],pqvd_ak_room_code:['pqvd_buildingid','pqvd_code'],pqvd_ak_equipment_tag:['pqvd_assettag'],pqvd_ak_equipmentfinance_equipment:['pqvd_equipmentid'],pqvd_ak_assignment_number:['pqvd_number'],pqvd_ak_servicerequest_number:['pqvd_number'],pqvd_ak_workorder_number:['pqvd_number'],pqvd_ak_worktask_sequence:['pqvd_workorderid','pqvd_sequence'],pqvd_ak_checklistitem_sequence:['pqvd_taskid','pqvd_sequence'],pqvd_ak_inspection_attempt:['pqvd_checklistitemid','pqvd_attempt'],pqvd_ak_finding_sequence:['pqvd_inspectionid','pqvd_sequence'],
  pqvd_ak_testrun_key:['pqvd_runkey'],pqvd_ak_testresult_part:['pqvd_runid','pqvd_observationkey','pqvd_artifactkind','pqvd_partnumber'],pqvd_ak_crudprobe_token:['pqvd_token'],pqvd_ak_pluginevent_part:['pqvd_operationid','pqvd_eventkey','pqvd_partnumber'],pqvd_ak_chainnode_code:['pqvd_operationid','pqvd_nodecode'],
};
for(const [source,solution] of [[section(core,'Tables columns and keys'),coreSolution],[section(harness,'Persistent history and disposable probe schema'),supportSolution]]) {
  for(const row of rows(source)) if(/^`\w+` \/ `\w+`$/.test(row[0])) {
    const table=tables.find(t=>t.name===refs(row[0])[0]);
    for(const name of refs(row[2]).filter(n=>n.startsWith('pqvd_ak_'))) {if(!keyColumns[name])throw new Error('Unmapped key '+name);table.keys.push({name,columns:keyColumns[name],solution});}
  }
}
tables.find(t=>t.name==='pqvd_pluginevent').keys.push({name:'pqvd_ak_pluginevent_part',columns:keyColumns.pqvd_ak_pluginevent_part});
tables.find(t=>t.name==='pqvd_chainnode').keys.push({name:'pqvd_ak_chainnode_code',columns:keyColumns.pqvd_ak_chainnode_code});
for(const [field,definition] of lookupFields) if(!relationships.some(r=>r.kind==='oneToMany'&&r.child+'.'+r.lookup.name===field)) throw new Error('Unregistered lookup '+field+' -> '+definition.target);
const manifest=validateManifest({schemaVersion:1,language:1033,publisher:{uniqueName:'PaqviloCompanyOperations',friendlyName:'Paqvilo Company Operations',prefix:'pqvd',optionValuePrefix:18327},solutions:[{uniqueName:coreSolution,friendlyName:'Company Operations Core',version:'1.0.0.0'},{uniqueName:'PaqviloCompanyOperationsForms',friendlyName:'Company Operations Forms',version:'1.0.0.0',dependsOn:[coreSolution]},{uniqueName:supportSolution,friendlyName:'Permission Test Support',version:'1.0.0.0',dependsOn:[coreSolution]},{uniqueName:evidenceSolution,friendlyName:'Plugin Evidence',version:'1.0.0.0',dependsOn:[coreSolution,supportSolution]},{uniqueName:pluginSolution,friendlyName:'Behaviour Plugins',version:'1.0.0.0',dependsOn:[evidenceSolution,supportSolution]}],choices,tables,relationships,forms:[],views:[],scope:{prepared:'Table/column/choice/relationship/key structure from the three specifications',remaining:'Named forms/views, website components, plugin binaries/steps/images, flows, runtime invariants and seed data are subsequent implementation increments; default forms/views are platform-generated.'}});
extendReferenceSchema(manifest);
validateManifest(manifest);
const output=args.out?path.resolve(args.out):path.join(project,'dataverse/manifest.json');
await fs.mkdir(path.dirname(output),{recursive:true});
await fs.writeFile(output,JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({tables:tables.length,newTables:tables.filter(t=>!t.existing).length,choices:choices.length,relationships:manifest.relationships.length,keys:tables.reduce((n,t)=>n+t.keys.length,0),columns:tables.reduce((n,t)=>n+t.columns.length,0),prepared:output,liveMutations:0}));
