import fs from 'node:fs/promises';
import path from 'node:path';
import { createSimulator } from '../../server.mjs';
import { profileFixture } from './deployment-profiles.mjs';

export const contactId = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
export const personaCatalog = (count = 50, offset = 0, groupCount = 5) => ({version:1,
  groups:Array.from({length:groupCount},(_,i)=>({id:`group-${i}`,label:`Group ${i}`,order:i,subgroups:[{id:'team',label:'Team'}]})),
  personas:Array.from({length:count},(_,i)=>({key:`person-${i+1+offset}`,contactId:contactId(i+1+offset),label:`Persona ${i+1+offset}`,group:`group-${i%groupCount}`,subgroup:'team',tags:[i%2?'review':'edit'],description:`Synthetic person ${i+1+offset}\nSupports catalogue tests.`})),
});
export async function personaFixture(t, {count=60, curated=50, groupCount=5, ...options} = {}) {
  const fixture=await profileFixture(t);
  await fs.writeFile(path.join(fixture.sourceDir,'webrole.yml'),' - adx_webroleid: reviewer\n   adx_name: Reviewer');
  const catalog=personaCatalog(curated,0,groupCount);
  catalog.personas.push({key:'state-missing',contactId:contactId(count+100),group:'group-0'});
  catalog.contexts=[{id:'review',label:'Review setup',deploymentProfile:{profile:'test'},environmentVariables:{sample_Url:'Context variable'},portalOverrides:{snippets:{Greeting:'Context greeting'},settings:{'Feature/Flag':'context'}},browser:{locale:'fr-FR',viewport:{width:1100,height:750}}}];
  if(catalog.personas[1])catalog.personas[1].context='review';
  catalog.scenarios=[{id:'review-flow',label:'Review flow',group:'group-0',persona:'person-1',context:'review',startPath:'/?scenario=review'}];
  const packCatalog=personaCatalog(5,curated,groupCount);
  packCatalog.personas.push({key:'pack-missing-one',contactId:contactId(count+101),group:'group-0'},{key:'pack-missing-two',contactId:contactId(count+102),group:'group-0'});
  const initial={version:1,mappings:{contact:{entitySet:'contacts',idColumn:'contactid'},account:{entitySet:'accounts',idColumn:'accountid'}},
    tables:{contact:Array.from({length:count},(_,i)=>({contactid:contactId(i+1),fullname:i===0?'Réquester One':`Contact ${i+1}`,emailaddress1:`person${i+1}@example.test`,parentcustomerid:{id:'account-one',logical_name:'account'},statecode:0})),account:[{accountid:'account-one',name:'Synthetic Account'}]},
    settings:{permissionMode:'permissive'},personaCatalog:catalog,
    simulator:{mode:'local',pageMode:'local',permissionSource:'configured',identity:{contactId:contactId(1),roleSource:'memberships'},contactRoles:[{contactId:contactId(1),roleId:'reviewer'}],endpoints:[]},
  };
  const pack={id:'persona-fixture',name:'Synthetic personas',description:'Invented fixture only',matches:()=>true,presets:()=>({}),personaCatalog:packCatalog};
  const app=await createSimulator({...fixture,initial,packs:[pack],watch:false,...options});
  fixture.onCleanup(()=>app.close());
  const call=async(route,method='GET',body,headers={})=>{
    const response=await fetch(app.url+'/_sim/api'+route,{method,headers:{'content-type':'application/json','x-sim-csrf':app.state().csrf,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {response,value:await response.json()};
  };
  return {...fixture,app,call,initial,pack};
}
