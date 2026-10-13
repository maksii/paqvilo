import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {loadConnection,connectedClient,exportSolution} from '../../../lense/dataverse/index.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),solutionName='PaqviloCompanyOperationsPortal';
export async function packagePortal({client,siteId,apply=false,exportArchive=false,evidenceDirectory,onProgress=()=>{}}) {
  if(!path.resolve(evidenceDirectory).split(path.sep).includes('.paqvilo'))throw new Error('Keep environment exports in ignored .paqvilo.');
  const site=await client.get(`powerpagesites(${siteId})`);if(site.datamodelversion!=='2.0'||site.enhancedauthorization!==0)throw new Error('Requires enhanced data model and traditional authorization.');
  const definitions=await client.list("solutioncomponentdefinitions?$filter=startswith(name,'powerpage')&$select=name,solutioncomponenttype"),type=name=>definitions.find(d=>d.name===name)?.solutioncomponenttype;
  if(!type('powerpagecomponent')||!type('powerpagesite')||!type('powerpagesitelanguage'))throw new Error('Missing discovered portal solution component types.');
  const components=await client.list(`powerpagecomponents?$filter=_powerpagesiteid_value eq ${siteId}&$select=powerpagecomponentid,name`),languages=await client.list(`powerpagesitelanguages?$filter=_powerpagesiteid_value eq ${siteId}&$select=powerpagesitelanguageid`);
  const candidates=[{id:siteId,type:type('powerpagesite'),name:site.name},...languages.map(l=>({id:l.powerpagesitelanguageid,type:type('powerpagesitelanguage'),name:'site language'})),...components.map(c=>({id:c.powerpagecomponentid,type:type('powerpagecomponent'),name:c.name}))];
  const publishers=await client.list("publishers?$filter=uniquename eq 'PaqviloCompanyOperations'&$select=publisherid");if(publishers.length!==1)throw new Error('Project publisher must already exist.');
  let solutions=await client.list(`solutions?$filter=uniquename eq '${solutionName}'&$select=solutionid,uniquename,_publisherid_value`);if(solutions.length>1)throw new Error('Ambiguous portal solution');
  if(solutions[0]&&solutions[0]._publisherid_value!==publishers[0].publisherid)throw new Error('Portal solution publisher mismatch.');
  const current=solutions.length?await client.list(`solutioncomponents?$filter=_solutionid_value eq ${solutions[0].solutionid}&$select=objectid,componenttype`):[],has=new Set(current.map(c=>c.componenttype+':'+c.objectid));
  await fs.mkdir(evidenceDirectory,{recursive:true});const stamp=new Date().toISOString().replaceAll(':','-'),out=path.join(evidenceDirectory,'package-'+stamp+'.json'),journal={mode:apply?'apply':'read-only',solutionName,websiteId:siteId,startedAt:new Date().toISOString(),entries:[],componentTypes:definitions};
  const save=()=>fs.writeFile(out,JSON.stringify(journal,null,2));await save();
  if(apply&&!solutions.length){await client.request('solutions',{method:'POST',body:{uniquename:solutionName,friendlyname:'Company Operations Portal',version:'1.0.0.0',description:'Isolated Company Operations permission regression website; depends on Core, forms, support and plugin evidence.', 'publisherid@odata.bind':`/publishers(${publishers[0].publisherid})`}});solutions=await client.list(`solutions?$filter=uniquename eq '${solutionName}'&$select=solutionid`);if(solutions.length!==1)throw new Error('Created solution not found');}
  for(const candidate of candidates){const action=has.has(candidate.type+':'+candidate.id)?'exists':'add';if(apply&&action==='add')await client.request('AddSolutionComponent',{method:'POST',body:{ComponentId:candidate.id,ComponentType:candidate.type,SolutionUniqueName:solutionName,AddRequiredComponents:false,DoNotIncludeSubcomponents:false}});journal.entries.push({...candidate,action});await save();onProgress(journal.entries.at(-1));}
  if(apply){const members=await client.list(`solutioncomponents?$filter=_solutionid_value eq ${solutions[0].solutionid}&$select=objectid,componenttype`),set=new Set(members.map(c=>c.componenttype+':'+c.objectid));journal.verification={missing:candidates.filter(c=>!set.has(c.type+':'+c.id)).map(c=>c.id),siteCount:members.filter(c=>c.componenttype===type('powerpagesite')).length};await save();if(journal.verification.missing.length||journal.verification.siteCount!==1)throw new Error('Portal solution membership does not match isolated site.');}
  if(exportArchive){if(!apply)throw new Error('--export requires --apply after membership reconciliation');journal.export=await exportSolution({client,solutionName,zipFile:path.join(evidenceDirectory,solutionName+'-'+stamp+'.zip'),unpackFolder:path.join(evidenceDirectory,'unpacked-'+stamp)});}
  journal.finishedAt=new Date().toISOString();await save();return {solutionName,websiteId:siteId,components:candidates.length,added:journal.entries.filter(e=>e.action==='add').length,journal:out,verification:journal.verification,export:journal.export};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),arg=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];},siteId=arg('--site');if(!/^[a-f0-9-]{36}$/i.test(siteId??''))throw new Error('--site GUID required.');
  const connection=await loadConnection(arg('--connection')??'.paqvilo/dataverse/provisioning.connection.json'),client=connectedClient(connection);await client.verify(connection.organisationId);let count=0;
  console.log(JSON.stringify(await packagePortal({client,siteId,apply:args.includes('--apply'),exportArchive:args.includes('--export'),evidenceDirectory:path.join(project,'.paqvilo/portal-security/portal-solution'),onProgress:e=>{count++;if(count%40===0)console.log(JSON.stringify({completed:count,name:e.name,action:e.action}));}})));
}
