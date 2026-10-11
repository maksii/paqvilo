import { DataError } from './data-error.mjs';
import {executeBulkRecords} from './plugin-bulk.mjs';
import {executeAssociation} from './plugin-association.mjs';
import {isExactNumeric,exactNumeric} from './exact-numeric.mjs';
const fail=(message,code='LocalOrganizationServiceUnsupported',status=501)=>{throw new DataError(message,status,code);};
const uuid=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const own=(o,k)=>o!=null&&Object.hasOwn(o,k);
/** Explicit local backend grants are independent of portal roles. No default system user. */
export function validateServiceProfile(profile){
 if(!profile||!uuid.test(profile.userId??'')||typeof profile.evidence!=='string'||!profile.evidence.trim()||!Array.isArray(profile.grants))fail('A project-supplied backend user ID, evidence and explicit grants are required.','LocalBackendIdentityRequired',409);
 for(const grant of profile.grants)if(!grant||!/^[a-z][a-z0-9_]*$/i.test(grant.entity??'')||!Array.isArray(grant.operations)||grant.operations.some(op=>!['read','create','update','delete','associate','disassociate'].includes(op))||grant.predicate!==undefined&&typeof grant.predicate!=='function')fail('Invalid local backend grant.','LocalBackendIdentityRequired',409);
 if(profile.bulkTables!==undefined&&(!Array.isArray(profile.bulkTables)||new Set(profile.bulkTables.map(table=>table?.entity)).size!==profile.bulkTables.length||profile.bulkTables.some(table=>!table||!/^[a-z][a-z0-9_]*$/i.test(table.entity??'')||table.tableType!=='standard'||typeof table.evidence!=='string'||!table.evidence.trim()||!Array.isArray(table.messages)||!table.messages.length||table.messages.some(message=>!['CreateMultiple','UpdateMultiple'].includes(message)))))fail('Bulk capabilities require unique source-evidenced standard tables and explicit supported message names.','LocalBackendIdentityRequired',409);
 return profile;
}
export function localOrganizationService(store,profile){
 validateServiceProfile(profile);
 const localIdentity={id:profile.userId,admin:true}; // Bypass portal grants only AFTER the separate backend grant check below.
 const authorize=(entity,operation,row)=>{const logical=store.resolveMapping(entity).logicalName;const grants=profile.grants.filter(g=>g.entity===logical&&g.operations.includes(operation));if(!grants.some(g=>!g.predicate||g.predicate(structuredClone(row),operation)===true))fail(`Local backend profile denied ${operation} on ${logical}.`,'LocalBackendPermissionDenied',403);return logical;};
 const rawGet=(entity,id)=>{const row=store.get(entity,id,localIdentity,{skipPluginRead:true});if(!row)fail('Record not found.','NotFound',404);authorize(entity,'read',row);return row;};
 const get=(entity,id,columns,{responseToken}={})=>{const mapping=store.resolveMapping(entity),raw=store.get(entity,id,localIdentity,{skipPluginRead:true});if(!raw)fail('Record not found.','NotFound',404);authorize(entity,'read',raw);const row=store.get(entity,id,localIdentity,{sdkColumns:columns,sdkResponseToken:responseToken});return structuredClone(row);};
 const writeGraph=(values,entity)=>{for(const[key,value]of Object.entries(values??{})){
  if(key.endsWith('@odata.bind')){for(const binding of [value].flat()){if(binding===null)continue;const match=/^\/?([a-z][\w]*)\(([a-f\d-]{36})\)$/i.exec(binding??'');if(!match)fail('Unsupported backend lookup binding.');rawGet(match[1],match[2]);}}
  else if(value&&typeof value==='object'&&value.logical_name&&value.id)rawGet(value.logical_name,value.id);
  else if(Array.isArray(value)&&String(store.fieldDefinition(entity,key)?.dataverseType??store.fieldDefinition(entity,key)?.type??'').toLowerCase()==='multiselectpicklist'){
   const options=store.fieldDefinition(entity,key)?.options;
   if(value.some(option=>typeof option!=='number'||!Number.isInteger(option)||option< -2147483648||option>2147483647||options?.length&&!options.some(allowed=>Number(allowed.value)===option)))fail('Backend choices require source-valid Int32 option values.');
  }
  else if(value&&typeof value==='object'&&!isExactNumeric(value))fail('Backend deep writes require an explicit security adapter.');
 }};
 return {
  get,
  query(entity,params={},{responseToken}={}){if(params instanceof URLSearchParams?params.has('$expand'):params.$expand)fail('Backend query expansion requires an explicit security adapter.');const logical=store.resolveMapping(entity).logicalName,grants=profile.grants.filter(g=>g.entity===logical&&g.operations.includes('read'));if(!grants.length)fail('Local backend profile denied read on '+logical,'LocalBackendPermissionDenied',403);const constrained=!grants.some(g=>!g.predicate);const p=params instanceof URLSearchParams?Object.fromEntries(params):params;if(constrained&&(p.$apply||String(p.$filter??'').includes('/')||String(p.$select??'').includes('/')||String(p.$orderby??'').includes('/')))fail('Predicate-backed queries support direct root fields only; navigation/aggregate needs a row-security adapter.');return store.query(entity,params,localIdentity,undefined,{dialect:'dataverse',sdkResponseToken:responseToken,backendRowFilter:constrained?row=>grants.some(g=>g.predicate(structuredClone(row),'read')===true):undefined});},
  fetch(xml,options={}){if(typeof xml!=='string')fail('FetchXML must be a string.');const tables=[...xml.matchAll(/<(?:entity|link-entity)\s[^>]*name=["']([\w]+)["']/gi)].map(m=>m[1]);if(!tables.length)fail('FetchXML entity is missing.');const grants=new Map();for(const name of tables){const logical=store.resolveMapping(name).logicalName,matching=profile.grants.filter(g=>g.entity===logical&&g.operations.includes('read'));if(!matching.length)fail('Local backend profile denied read on '+logical,'LocalBackendPermissionDenied',403);grants.set(logical,matching);}return store.fetchXml(xml,localIdentity,{...options,backendRowsFilter:(logical,row)=>(grants.get(logical)??[]).some(g=>!g.predicate||g.predicate(structuredClone(row),'read')===true)});},
  create(entity,values,{responseToken}={}){authorize(entity,'create',values);writeGraph(values,entity);return store.sdkMutation(()=>store.createRecord(entity,values,localIdentity,{coerce:true,sdkResponseToken:responseToken}));},
  update(entity,id,values,{responseToken}={}){const previous=store.get(entity,id,localIdentity,{skipPluginRead:true});if(!previous)fail('Record not found.','NotFound',404);authorize(entity,'update',previous);authorize(entity,'update',{...previous,...values});writeGraph(values,entity);return store.sdkMutation(()=>store.updateRecord(entity,id,values,localIdentity,{coerce:true,sdkResponseToken:responseToken}));},
  remove(entity,id,{responseToken}={}){const previous=store.get(entity,id,localIdentity,{skipPluginRead:true});if(!previous)fail('Record not found.','NotFound',404);authorize(entity,'delete',previous);return store.sdkMutation(()=>store.removeRecord(entity,id,localIdentity,{sdkResponseToken:responseToken}));},
  associate(entity,id,relationship,related,associate=true,{responseToken}={}){return store.sdkMutation(()=>executeAssociation({store,entity,id,relationship,related,identity:localIdentity,authorize,associate,responseToken}));},
  bulk(operation,targets,{responseToken}={}){const entity=targets?.[0]?.logicalName,source=(profile.bulkTables??[]).find(table=>table.entity===entity);if(!source||!source.messages.includes(operation==='createmultiple'?'CreateMultiple':'UpdateMultiple'))fail('Bulk requires explicit source-evidenced standard table and available SDK message capability.','LocalPluginBulkUnsupported');return store.sdkMutation(()=>executeBulkRecords({store,entity,operation,targets:structuredClone(targets),identity:localIdentity,responseToken,authorize:(op,row,previous)=>{if(previous)authorize(entity,op,previous);authorize(entity,op,row);writeGraph(row,entity);}}));},
  mapping:entity=>store.resolveMapping(entity),
  profile:{userId:profile.userId,evidence:profile.evidence,securityModel:'Explicit project local backend grants; not inferred Dataverse security-role parity'},
 };
}
/** SDK wire values carry their .NET type instead of erasing Money/lookups/options. */
export function sdkValueToRecord(value){
 if(isExactNumeric(value))return structuredClone(value);
 if(Array.isArray(value))return value.map(sdkValueToRecord);
 if(!value||typeof value!=='object')return value;
 switch(value.$type){
  case 'Guid':case 'DateTime':return value.value;
  case 'Money':case 'Decimal':return exactNumeric(value.value,value.$type);
  case 'Int64':return exactNumeric(value.value,'Int64');
  case 'Double':{
   const raw=value.value,number=typeof raw==='number'?raw:typeof raw==='string'&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)?Number(raw):NaN;
   if(!Number.isFinite(number))fail('SDK Double requires a finite numeric value.');return number;
  }
  case 'OptionSetValueCollection':return value.values.map(v=>v.value??v);
  case 'OptionSetValue':return value.value;
  case 'EntityReference':return {id:value.id,logical_name:value.logicalName,...(value.name?{name:value.name}:{})};
  case 'AliasedValue':return sdkValueToRecord(value.value);
  case 'Entity':return Object.fromEntries(Object.entries(value.attributes??{}).map(([k,v])=>[k,sdkValueToRecord(v)]));
  default:if(own(value,'$type'))fail('Unsupported SDK value type: '+value.$type);return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sdkValueToRecord(v)]));
 }
}
