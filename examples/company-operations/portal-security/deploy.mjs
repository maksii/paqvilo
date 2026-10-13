import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConnection, connectedClient } from '../../../lense/dataverse/index.mjs';
import { buildBlueprint, validateBlueprint, assertNoActiveOrphans } from './blueprint.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const scopeValues={Global:756150000,Contact:756150001,Account:756150002,Parent:756150003,Self:756150004};
export function nativeActiveOrphans(components) {
  const permissions=new Map(components.filter(c=>c.powerpagecomponenttype===18).map(c=>[c.powerpagecomponentid.toLowerCase(),c]));
  return [...permissions.values()].filter(c=>c.statecode===0).flatMap(c=>{
    const content=JSON.parse(c.content??'{}');if(content.scope!==scopeValues.Parent)return [];
    const parentId=content.parententitypermission,parent=typeof parentId==='string'?permissions.get(parentId.toLowerCase()):undefined;
    return parent?.statecode===0?[]:[{id:c.powerpagecomponentid,name:c.name,parentId:parentId??null,reason:parent?'inactive-parent':'missing-parent'}];
  });
}
export function permissionContent(node,blueprint) {
  const p=node.privileges,role=blueprint.roles.find(r=>r.code===node.role);
  return {entityname:node.name,entitylogicalname:node.table,scope:scopeValues[node.scope],
    read:p.read,create:p.create,write:p.write,delete:p.delete,append:p.append,appendto:p.appendTo,
    ...(node.scope==='Contact'?{contactrelationship:node.relationship}:{}),
    ...(node.parent?{parententitypermission:blueprint.nodes.find(n=>n.key===node.parent).id,parentrelationship:node.relationship}:{}),
    adx_entitypermission_webrole:[role.id]};
}
function desiredComponents(b) {
  return [...b.roles.map(r=>({id:r.id,type:11,name:r.name,state:0,content:{anonymoususersrole:false,authenticatedusersrole:false,description:'Company Operations '+r.code+'; scope comes from effective role-specific access grants.'}})),
    ...b.nodes.map(n=>({id:n.id,type:18,name:n.name,state:n.active?0:1,content:permissionContent(n,b)}))];
}
function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
function differences(actual,wanted) {
  const content=JSON.parse(actual.content??'{}'),issues=[];
  if(actual.name!==wanted.name)issues.push('name');
  if(actual.powerpagecomponenttype!==wanted.type)issues.push('componentType');
  if(actual.statecode!==wanted.state)issues.push('state');
  for(const [key,value]of Object.entries(wanted.content))if(!same(content[key],value))issues.push('content.'+key);
  return issues;
}
export async function inspectSecurity(client,siteId,blueprint) {
  const site=await client.get(`powerpagesites(${siteId})`);
  if(site.datamodelversion!=='2.0'||site.enhancedauthorization!==0)throw new Error('Requires enhanced data model and traditional authorization.');
  const components=await client.list(`powerpagecomponents?$filter=_powerpagesiteid_value eq ${siteId}`),byId=new Map(components.map(r=>[r.powerpagecomponentid,r]));
  const desired=desiredComponents(blueprint),actions=desired.map(w=>({id:w.id,name:w.name,kind:w.type===11?'role':'permission',action:!byId.has(w.id)?'create':differences(byId.get(w.id),w).length?'update':'exists',differences:byId.has(w.id)?differences(byId.get(w.id),w):[]}));
  const defaultRoles=components.filter(r=>r.powerpagecomponenttype===11&&r.statecode===0&&JSON.parse(r.content??'{}').authenticatedusersrole).map(r=>r.powerpagecomponentid);
  const anonymousRoles=components.filter(r=>r.powerpagecomponenttype===11&&r.statecode===0&&JSON.parse(r.content??'{}').anonymoususersrole).map(r=>r.powerpagecomponentid);
  const contaminations=components.filter(r=>r.powerpagecomponenttype===18&&r.statecode===0).filter(r=>{const c=JSON.parse(r.content??'{}');return ['account','contact',...new Set(blueprint.nodes.map(n=>n.table))].includes(c.entitylogicalname)&&c.scope===scopeValues.Global&&c.adx_entitypermission_webrole?.some(id=>[...defaultRoles,...anonymousRoles].includes(id));}).map(r=>({id:r.powerpagecomponentid,name:r.name,table:JSON.parse(r.content).entitylogicalname}));
  const associations=[];
  for(const a of blueprint.assignments){const existing=await client.list(`contacts(${a.contactId})/powerpagecomponent_mspp_webrole_contact?$select=powerpagecomponentid,name`),ids=new Set(existing.map(r=>r.powerpagecomponentid));for(const role of a.roles){const id=blueprint.roles.find(r=>r.code===role).id;associations.push({contactId:a.contactId,persona:a.persona,roleId:id,role,action:ids.has(id)?'exists':'create'});}}
  return {site:{id:siteId,name:site.name,domain:site.primarydomainname,dataModel:site.datamodelversion,enhancedAuthorization:site.enhancedauthorization},actions,associations,contaminations,activeOrphans:nativeActiveOrphans(components),components,byId,desired};
}
export async function deploySecurity(client,siteId,blueprint,{apply=false,evidenceDirectory,onProgress=()=>{}}={}) {
  assertNoActiveOrphans(blueprint);
  if(!evidenceDirectory||!path.resolve(evidenceDirectory).split(path.sep).includes('.paqvilo'))throw new Error('Environment evidence must stay under ignored .paqvilo.');
  await fs.mkdir(evidenceDirectory,{recursive:true});
  const plan=await inspectSecurity(client,siteId,blueprint),stamp=new Date().toISOString().replaceAll(':','-'),journal={startedAt:new Date().toISOString(),mode:apply?'apply':'read-only',site:plan.site,entries:[],contaminations:plan.contaminations,activeOrphans:plan.activeOrphans};
  const target=path.join(evidenceDirectory,`${apply?'apply':'plan'}-${stamp}.json`);
  await fs.writeFile(path.join(evidenceDirectory,`before-${stamp}.json`),JSON.stringify(plan.components,null,2),{flag:'wx'});
  const save=()=>fs.writeFile(target,JSON.stringify(journal,null,2));await save();
  if(apply&&plan.contaminations.length)throw new Error('Active default/anonymous Global grants contaminate site; deactivate the known sample grants first.');
  if(apply&&plan.activeOrphans.length)throw new Error('Active native orphan permissions require recovery before deployment; automatic parent reconciliation is unsafe.');
  for(const wanted of plan.desired) {
    const existing=plan.byId.get(wanted.id),action=!existing?'create':differences(existing,wanted).length?'update':'exists';
    if(existing&&(existing.name!==wanted.name||existing.powerpagecomponenttype!==wanted.type))throw new Error('Component GUID collision '+wanted.id);
    if(apply&&action!=='exists') {
      const body={name:wanted.name,content:JSON.stringify(wanted.content),statecode:wanted.state,statuscode:wanted.state===0?1:2};
      if(!existing){body.powerpagecomponentid=wanted.id;body.powerpagecomponenttype=wanted.type;body['powerpagesiteid@odata.bind']=`/powerpagesites(${siteId})`;}
      await client.request(existing?`powerpagecomponents(${wanted.id})`:'powerpagecomponents',{method:existing?'PATCH':'POST',body});
    }
    journal.entries.push({id:wanted.id,name:wanted.name,kind:wanted.type===11?'role':'permission',action});await save();onProgress(journal.entries.at(-1));
  }
  for(const a of plan.associations){if(apply&&a.action==='create')await client.request(`contacts(${a.contactId})/powerpagecomponent_mspp_webrole_contact/$ref`,{method:'POST',body:{'@odata.id':client.url(`powerpagecomponents(${a.roleId})`)}});journal.entries.push({kind:'assignment',...a});await save();onProgress(journal.entries.at(-1));}
  journal.finishedAt=new Date().toISOString();journal.state=apply?'Applied':'Planned';await save();
  if(apply){const after=await inspectSecurity(client,siteId,blueprint);await fs.writeFile(path.join(evidenceDirectory,`after-${stamp}.json`),JSON.stringify(after.components,null,2),{flag:'wx'});journal.verification={remainingChanges:after.actions.filter(a=>a.action!=='exists'),missingAssignments:after.associations.filter(a=>a.action!=='exists'),contaminations:after.contaminations,activeOrphans:after.activeOrphans};await save();if(journal.verification.remainingChanges.length||journal.verification.missingAssignments.length||journal.verification.contaminations.length||journal.verification.activeOrphans.length)throw new Error('Security verification has unresolved changes.');}
  return {journal:target,site:plan.site,roles:blueprint.roles.length,permissions:blueprint.nodes.length,personaAssignments:plan.associations.length,changes:journal.entries.filter(e=>e.action!=='exists').length,activeOrphans:plan.activeOrphans.length,state:journal.state,verification:journal.verification};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),arg=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  const siteId=arg('--site');if(!/^[0-9a-f-]{36}$/i.test(siteId??''))throw new Error('--site GUID is required.');
  const schema=JSON.parse(await fs.readFile(path.join(project,'dataverse/manifest.json'))),catalogue=JSON.parse(await fs.readFile(arg('--catalogue')??path.join(project,'data/catalogue.json'))),b=buildBlueprint(schema,catalogue);
  validateBlueprint(b,schema);await fs.writeFile(path.join(project,'portal-security/blueprint.json'),JSON.stringify(b,null,2)+'\n');
  const variant=arg('--variant');if(variant)throw new Error('Parent-only permission variants are blocked after observed broad visibility leakage. Use the bounded complete-subtree deep variant; recorded orphan faults are negative security evidence.');
  const connection=await loadConnection(arg('--connection')??'.paqvilo/dataverse/provisioning.connection.json'),client=connectedClient(connection);await client.verify(connection.organisationId);
  let count=0;console.log(JSON.stringify(await deploySecurity(client,siteId,b,{apply:args.includes('--apply'),evidenceDirectory:path.join(project,'.paqvilo/portal-security'),onProgress:e=>{count++;if(count%25===0)console.log(JSON.stringify({completed:count,current:e.name??e.persona,action:e.action}));}})));
}
