import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConnection, connectedClient } from '../../../lense/dataverse/index.mjs';
import { buildBlueprint } from './blueprint.mjs';

export function planStressRoleVariant(blueprint,persona,roleCount,currentRoleIds) {
  if(!persona?.stress||persona.key!=='P-STRESS')throw new Error('Role variants only support the isolated stress persona.');
  if(![0,1,2,4,8,12].includes(roleCount))throw new Error('Role count must be 0/1/2/4/8/12.');
  const variant=persona.webRoleVariants.find(v=>v.roles.length===roleCount);if(!variant)throw new Error('Missing authored role variant');
  const desired=['TESTRUNNER',...variant.roles].map(code=>blueprint.roles.find(r=>r.code===code)?.id);if(desired.some(id=>!id))throw new Error('Unknown role');
  const own=new Set(blueprint.roles.map(r=>r.id)),current=new Set(currentRoleIds),wanted=new Set(desired);
  return {variant:variant.id,roleCount,desired,add:desired.filter(id=>!current.has(id)),remove:[...current].filter(id=>own.has(id)&&!wanted.has(id)),preserved:[...current].filter(id=>!own.has(id)),portalSessionQualification:'Re-sign in or refresh site security cache, then require Liquid user.roles to match the selected role variant before measuring joins.'};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),arg=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];},project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  if(!arg('--role-count'))throw new Error('--role-count is required (0/1/2/4/8/12).');
  const catalogue=JSON.parse(await fs.readFile(path.join(project,'data/stress-catalogue.json'))),schema=JSON.parse(await fs.readFile(path.join(project,'dataverse/manifest.json'))),blueprint=buildBlueprint(schema,catalogue),persona=catalogue.personas.find(p=>p.key==='P-STRESS');
  const connection=await loadConnection(arg('--connection')??'.paqvilo/dataverse/provisioning.connection.json'),client=connectedClient(connection);await client.verify(connection.organisationId);
  const actor=await client.get(`contacts(${persona.contactId})?$select=contactid,pqvd_personcode`),fixture=catalogue.records.find(r=>r.id===actor.contactid);if(actor.pqvd_personcode!==fixture?.fields.pqvd_personcode)throw new Error('Stress persona does not match the seeded fixture.');
  const current=await client.list(`contacts(${actor.contactid})/powerpagecomponent_mspp_webrole_contact?$select=powerpagecomponentid`),plan=planStressRoleVariant(blueprint,persona,Number(arg('--role-count')),current.map(r=>r.powerpagecomponentid)),journal={startedAt:new Date().toISOString(),contactId:actor.contactid,mode:args.includes('--apply')?'apply':'read-only',...plan,entries:[]},dir=path.join(project,'.paqvilo/portal-security');await fs.mkdir(dir,{recursive:true});
  const out=path.join(dir,'role-variant-'+new Date().toISOString().replaceAll(':','-')+'.json'),save=()=>fs.writeFile(out,JSON.stringify(journal,null,2));await save();
  if(args.includes('--apply')){
    for(const id of plan.remove){await client.request(`contacts(${actor.contactid})/powerpagecomponent_mspp_webrole_contact(${id})/$ref`,{method:'DELETE'});journal.entries.push({action:'remove',id});await save();}
    for(const id of plan.add){await client.request(`contacts(${actor.contactid})/powerpagecomponent_mspp_webrole_contact/$ref`,{method:'POST',body:{'@odata.id':client.url(`powerpagecomponents(${id})`)}});journal.entries.push({action:'add',id});await save();}
    const after=await client.list(`contacts(${actor.contactid})/powerpagecomponent_mspp_webrole_contact?$select=powerpagecomponentid`);journal.verification=planStressRoleVariant(blueprint,persona,Number(arg('--role-count')),after.map(r=>r.powerpagecomponentid));if(journal.verification.add.length||journal.verification.remove.length)throw new Error('Role variant verification failed.');
  }
  journal.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({mode:journal.mode,variant:plan.variant,businessRoles:plan.roleCount,added:plan.add.length,removed:plan.remove.length,preservedForeignRoles:plan.preserved.length,journal:out,portalSessionQualification:plan.portalSessionQualification}));
}
