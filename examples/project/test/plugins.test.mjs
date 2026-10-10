import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSimulator} from 'paqvilo/mirage/server.mjs';
import {importSolutionMetadata} from 'paqvilo/mirage/lib/solution-metadata.mjs';
import {signInHeaders} from 'paqvilo/mirage/testing/session.mjs';
import {sdkMessages} from '../pack/dataverse-plugins.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const roots=['metadata','code-solution','solution'].map(name=>path.join(project,name));
const observed={sdkMessages,evidence:'PAC-exported plugin registrations and Dataverse SDK message reads on 2026-10-10.'};

test('exported plugin steps use explicit local models for validation, normalization and atomic writes',async t=>{
 const metadata=await importSolutionMetadata(roots,{observed});
 assert.equal(metadata.plugins.assemblies.length,1);assert.equal(metadata.plugins.types.length,2);assert.equal(metadata.plugins.steps.length,8);
 assert.ok(metadata.plugins.steps.every(step=>step.unsupported===null&&['Create','Update'].includes(step.message)&&[10,20].includes(step.stage)),'all actual exported registrations resolve without guessed messages');
 const sim=await createSimulator({sourceDir:path.join(project,'portal'),solutionRoots:roots,solutionOrder:'explicit',observed,dataPacks:[{module:path.join(project,'pack/pack.mjs')}],port:0,watch:false});t.after(()=>sim.close());await sim.applyPreset('example-demo');
 const signed=signInHeaders(sim,'a4300000-0000-4000-8000-000000002001');
 const write=(resource,method,body)=>fetch(sim.url+'/_api/'+resource,{method,headers:{...signed,'Content-Type':'application/json',__RequestVerificationToken:sim.state().csrf},body:body===undefined?undefined:JSON.stringify(body)});
 const read=async resource=>{const response=await fetch(sim.url+'/_api/'+resource,{headers:signed});assert.equal(response.status,200,await response.clone().text());return response.json();};
 const reject=async(resource,method,body,message)=>{const response=await write(resource,method,body);assert.equal(response.status,400,await response.clone().text());const {error}=await response.json();assert.equal(error.code,'9004010D');assert.equal(error.message,'CDS error occurred.');assert.equal(error.innererror.message,message);};
 await reject('accounts','POST',{name:'AB'},'Account name must contain at least 3 characters.');assert.equal((await read('accounts?$select=accountid')).value.length,12,'rejected Create adds no record');
 const created=await write('accounts','POST',{name:'  Plugin Élite  ',emailaddress1:'  INITIAL.ACCOUNT@Example.com  '});assert.equal(created.status,204,await created.text());const account=created.headers.get('entityid');
 let saved=await read('accounts('+account+')?$select=name,emailaddress1,tickersymbol');assert.equal(saved.name,'Plugin Élite');assert.equal(saved.emailaddress1,'initial.account@example.com');assert.equal(saved.tickersymbol,'PLUGINLITE');
 await reject('accounts('+account+')','PATCH',{name:' X ',emailaddress1:'CHANGED@EXAMPLE.COM'},'Account name must contain at least 3 characters.');saved=await read('accounts('+account+')?$select=name,emailaddress1');assert.equal(saved.name,'Plugin Élite');assert.equal(saved.emailaddress1,'initial.account@example.com','rejected Update rolls back all supplied fields');
 assert.equal((await write('accounts('+account+')','PATCH',{name:'  Revised Example  ',emailaddress1:'  REVISED.ACCOUNT@Example.com  '})).status,204);saved=await read('accounts('+account+')?$select=name,emailaddress1,tickersymbol');assert.equal(saved.name,'Revised Example');assert.equal(saved.emailaddress1,'revised.account@example.com');assert.equal(saved.tickersymbol,'REVISEDEXA');
 assert.equal((await write('accounts('+account+')','PATCH',{description:'Unrelated update',tickersymbol:'MANUAL'})).status,204);assert.equal((await read('accounts('+account+')?$select=tickersymbol')).tickersymbol,'MANUAL','Update filtering attributes prevent unrelated execution');
 await reject('contacts','POST',{lastname:'S'},'Contact last name must contain at least 2 characters.');
 const contactResponse=await write('contacts','POST',{firstname:'  Demo  ',lastname:'  Plugin  ',emailaddress1:'  INITIAL.CONTACT@Example.com  ','parentcustomerid_account@odata.bind':'/accounts('+account+')'});assert.equal(contactResponse.status,204,await contactResponse.text());const contact=contactResponse.headers.get('entityid');
 saved=await read('contacts('+contact+')?$select=firstname,lastname,fullname,emailaddress1,_parentcustomerid_value');assert.equal(saved.firstname,'Demo');assert.equal(saved.lastname,'Plugin');assert.equal(saved.fullname,'Demo Plugin');assert.equal(saved.emailaddress1,'initial.contact@example.com');assert.equal(saved._parentcustomerid_value,account);
 await reject('contacts('+contact+')','PATCH',{lastname:'Z',emailaddress1:'CHANGED@EXAMPLE.COM'},'Contact last name must contain at least 2 characters.');saved=await read('contacts('+contact+')?$select=lastname,emailaddress1');assert.equal(saved.lastname,'Plugin');assert.equal(saved.emailaddress1,'initial.contact@example.com');
 assert.equal((await write('contacts('+contact+')','PATCH',{firstname:'  Updated  ',lastname:'  Contact  ',emailaddress1:'  REVISED.CONTACT@Example.com  '})).status,204);saved=await read('contacts('+contact+')?$select=firstname,lastname,fullname,emailaddress1');assert.equal(saved.firstname,'Updated');assert.equal(saved.lastname,'Contact');assert.equal(saved.fullname,'Updated Contact');assert.equal(saved.emailaddress1,'revised.contact@example.com');
 assert.equal((await write('contacts('+contact+')','DELETE')).status,204);assert.equal((await write('accounts('+account+')','DELETE')).status,204);
});
