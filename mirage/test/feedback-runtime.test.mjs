import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createSimulator} from '../server.mjs';
import {DataStore} from '../lib/data.mjs';
import {readStateFile} from '../lib/state-storage.mjs';
import {importPortal} from '../lib/importer.mjs';
import {indexPersonaCatalog} from '../lib/persona-search.mjs';
import {chooserReport,chooserSelection} from '../lib/persona-chooser.mjs';
import {configurationPresetDiagnostics,defineLazyPreset} from '../packs.mjs';
import {nativeFormControlIds} from '../lib/native-postback.mjs';
import {createMirageContext} from '../api.mjs';
import {loadProjectConfig} from '../lib/project-config.mjs';
import {signInHeaders} from '../testing/session.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

async function fixture(t,{wizard=false,attachments=false,webapi=false,...options}={}){
  const root=await fs.mkdtemp(path.join(tmpdir(),'mirage-feedback-'));
  ownedFixture(t).remove(()=>fs.rm(root,{recursive:true,force:true}));
  const files={'website.yml':'adx_websiteid: site\nadx_name: Invented feedback',
    'Home.webpage.yml':'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'Main.pagetemplate.yml':'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'Main.webtemplate.yml':'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html':`<html><body><form id="liquid_form">{% ${wizard?'webform name: "Wizard"':'entityform name: "Edit"'} %}</form></body></html>`,
    'Edit.basicform.yml':'adx_entityformid: edit\nadx_name: Edit\nadx_entityname: item\nadx_mode: 100000001\nadx_recordidquerystringparametername: id',
    'Create.basicform.yml':'adx_entityformid: create\nadx_name: Create\nadx_entityname: item\nadx_mode: 100000000'+(attachments?'\nadx_attachfile: true':''),
    'Wizard.advancedform.yml':'adx_webformid: wizard\nadx_name: Wizard'};
  if(webapi){files['Api.sitesetting.yml']='adx_name: Webapi/item/enabled\nadx_value: True';files['Fields.sitesetting.yml']='adx_name: Webapi/item/fields\nadx_value: itemid,title';}
  for(const [file,body]of Object.entries(files))await fs.writeFile(path.join(root,file),body);
  const stateFile=path.join(root,'state.json'),settings={sourceDir:root,stateFile,watch:false,persistence:{journalThresholdBytes:0},...options};
  const initial={settings:{permissionMode:'permissive'},mappings:{item:{entitySet:'items',idColumn:'itemid'}},tables:{item:[{itemid:'one',title:'Before'}]},simulator:{componentSchemas:{edit:{entity:'item',fields:[{name:'title'}]},create:{entity:'item',fields:[{name:'title'}]},wizard:{initialStepId:'first',steps:[{stepId:'first',entity:'item',mode:100000000,fields:[{name:'title'}]}]}}}};
  if(attachments){initial.mappings.annotation={entitySet:'annotations',idColumn:'annotationid'};initial.tables.annotation=[];}
  const app=await createSimulator({...settings,initial});ownedFixture(t).add(()=>app.close());
  const submit=(route,body,type='application/json')=>fetch(app.url+route,{method:'POST',redirect:'manual',headers:{'content-type':type,__RequestVerificationToken:app.state().csrf},body:type==='application/json'?JSON.stringify(body):body});
  return {app,root,stateFile,settings,submit};
}

test('native edit, JSON insert and multistep writes use the journal and survive restart',async t=>{
  const {app,stateFile,settings,submit}=await fixture(t);
  const ids=nativeFormControlIds('entityform','edit');
  const response=await submit('/?id=one',new URLSearchParams([['__EVENTTARGET',ids.buttons+'UpdateButton'],['__RequestVerificationToken',app.state().csrf],[ids.names+'title','Edited']]),'application/x-www-form-urlencoded');
  assert.equal(response.status,200);await response.text();
  assert.equal((await submit('/__sim/forms/entityform/create/submit',{values:{title:'Inserted'}})).status,201);
  const audit=await (await fetch(app.url+'/__sim/api/audit?method=POST')).json();
  assert.ok(audit.items.length>=2);assert.ok(audit.items.filter(row=>row.saveMode).every(row=>row.saveMode==='journal'),JSON.stringify(audit.items.map(({path,saveMode})=>({path,saveMode}))));
  await app.close();const restarted=await createSimulator(settings);t.after(()=>restarted.close());
  assert.deepEqual(restarted.store.state.tables.item.map(row=>row.title),['Edited','Inserted']);
  assert.equal((await readStateFile(stateFile)).tables.item.length,2);
  const wizard=await fixture(t,{wizard:true});const controls=nativeFormControlIds('webform','wizard');
  const next=await wizard.submit('/',new URLSearchParams([['__EVENTTARGET',controls.buttons+'NextButton'],['__RequestVerificationToken',wizard.app.state().csrf],[controls.names+'title','Step saved']]),'application/x-www-form-urlencoded');
  assert.ok(next.status<400);await next.text();
  assert.equal(wizard.app.store.lastSave.mode,'journal');
});

test('a failing second form operation rolls back every journal row on disk and in memory',async t=>{
  const {app,stateFile,submit}=await fixture(t);
  app.store.state.simulator.componentSchemas.create.fields.push({name:'description'});
  app.store.state.plugins=[{entity:'item',operations:['create'],secondary:[{entity:'item',operation:'update',match:{itemid:'absent'},requireMatch:true,set:{title:'No match'}}]}];
  await app.store.compact();const before=app.store.snapshot();
  const response=await submit('/__sim/forms/entityform/create/submit',{values:{title:'Must rollback'}});
  assert.ok(response.status>=400,await response.text());
  assert.deepEqual(app.store.state.tables,before.tables);
  assert.deepEqual((await readStateFile(stateFile)).tables,before.tables);
});

test('attachment rejection after the primary form row rolls back the entire unit, with journal and trusted-handler promotion',async t=>{
  for(const trusted of [false,true]){
    const {app,stateFile,settings,submit}=await fixture(t,{attachments:true});
    const payload={values:{title:'With note'},attachments:[{name:'invented.txt',content:Buffer.from('Invented').toString('base64')}]};
    let handlerCalls=0;
    if(trusted)app.store.setPluginPipeline(event=>{
      if(event.stage===20&&event.entity==='item'){
        handlerCalls++;app.store.state.simulator.handlerMutation=handlerCalls;
      }
    },event=>event.entity==='item',event=>event.stage===20);
    const saved=await submit('/__sim/forms/entityform/create/submit',payload);
    assert.equal(saved.status,201,await saved.text());
    assert.equal(app.store.lastSave.mode,trusted?'checkpoint':'journal');
    app.store.state.plugins=[{entity:'annotation',operations:['create'],validate:[{assert:"filename eq 'allowed.txt'",message:'Reject attachment'}]}];
    await app.store.compact();const before=app.store.snapshot();
    const rejected=await submit('/__sim/forms/entityform/create/submit',payload);
    assert.ok(rejected.status>=400,await rejected.text());
    assert.deepEqual(app.store.state,before);
    assert.deepEqual((await readStateFile(stateFile)).tables,before.tables);
    if(trusted)assert.equal(handlerCalls,2,'the rejecting attachment follows the primary row and trusted handler');
    await app.close();const restarted=await createSimulator(settings);t.after(()=>restarted.close());
    // A restart moves the inline note body to the annotations storage route (dataverse-storage-routing.mjs migration);
    // the rows are otherwise unchanged.
    const rows=tables=>({...tables,annotation:tables.annotation?.map(({documentbody,__blobkey,...row})=>row)});
    assert.deepEqual(rows(restarted.store.state.tables),rows(before.tables));
  }
});

test('scoped Create denial names the grant and relationship and revokes independent PreValidation SDK writes',async t=>{
  const {stateFile}=await fixture(t);
  const store=await new DataStore({file:stateFile+'-scoped',persistence:{journalThresholdBytes:0},state:{settings:{permissionMode:'enforce'},mappings:{item:{idColumn:'itemid',entitySet:'items'},note:{idColumn:'noteid',entitySet:'notes'}},tables:{item:[],note:[]},permissions:[{id:'scoped',name:'Owned children',entity:'item',scope:'parent',roles:['Member'],operations:['create'],parentPermissionId:'parent',relationship:{entity:'note',from:'parentid',to:'noteid'}},{id:'parent',entity:'note',scope:'contact',field:'contactid',roles:['Member'],operations:['read']}]}}).init();
  store.setPluginPipeline(event=>{if(event.entity==='item'&&event.stage===10)store.sdkMutation(()=>store.createRecord('note',{text:'Independent'},{admin:true}));},()=>true,()=>true);
  await assert.rejects(store.create('items',{}, {contactId:'person',roles:['Member']}),error=>{assert.equal(error.code,'PermissionDenied',error.stack);assert.match(error.message,/Owned children.*parent.*parentid/);assert.equal(error.details.permissionDiagnostic.permissions[0].name,'Owned children');return true;});
  assert.deepEqual(store.state.tables,{item:[],note:[]});
  assert.deepEqual((await new DataStore({file:stateFile+'-scoped'}).init()).state.tables,{item:[],note:[]});
});

test('HTTP scoped Web API FetchXML omission deduplicates roots and pages while explicit false keeps multiplicity',async t=>{
  const {app}=await fixture(t,{webapi:true});
  app.store.state.settings.permissionMode='enforce';
  app.store.state.mappings.membership={idColumn:'membershipid',entitySet:'memberships'};
  app.store.state.tables.item=[{itemid:'one',title:'One'},{itemid:'two',title:'Two'}];
  app.store.state.tables.membership=['one','two'].flatMap(itemid=>[0,1,2].map(index=>({membershipid:itemid+index,itemid,contactid:'person'})));
  app.store.state.permissions=[{id:'membership',entity:'membership',scope:'contact',field:'contactid',roles:['Member'],operations:['read']},{id:'item-parent',entity:'item',scope:'parent',parentPermissionId:'membership',relationship:{entity:'membership',from:'itemid',to:'itemid'},roles:['Member'],operations:['read']}];
  const headers=signInHeaders(app,'person',{roles:['Member']}),fetchXml=async xml=>{
    const response=await fetch(app.url+'/_api/items?fetchXml='+encodeURIComponent(xml),{headers});
    assert.equal(response.status,200,await response.clone().text());return response.json();
  };
  const xml='<fetch><entity name="item"><attribute name="itemid"/><order attribute="itemid"/></entity></fetch>';
  assert.deepEqual((await fetchXml(xml)).value.map(row=>row.itemid),['one','two']);
  const first=await fetchXml(xml.replace('<fetch>','<fetch count="1">'));
  assert.equal(first.value.length,1);
  const wrapper=first['@Microsoft.Dynamics.CRM.fetchxmlpagingcookie'];
  assert.ok(wrapper);
  const cookie=decodeURIComponent(decodeURIComponent(/pagingcookie="([^"]+)"/.exec(wrapper)[1])).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const second=await fetchXml(xml.replace('<fetch>',`<fetch count="1" page="2" paging-cookie="${cookie}">`));
  assert.deepEqual([...first.value,...second.value].map(row=>row.itemid),['one','two']);
  assert.equal((await fetchXml(xml.replace('<fetch>','<fetch distinct="false">'))).value.length,6);
});

test('configuration-only packs have no phantom link errors and lazy mismatches are request errors',()=>{
  assert.deepEqual(configurationPresetDiagnostics({id:'configuration-only',configurationPresets:[]}),[]);
  const library={};defineLazyPreset(library,'sample',{configurationPreset:'one',load:()=>({configurationPreset:'two'})});
  assert.throws(()=>library.sample,error=>error.status===400&&error.code==='PACK_CONFIGURATION_PRESET_LINK_INVALID');
});

test('a configuration-only pack loads into a runtime and can apply its configuration',async t=>{
  const pack={id:'configuration-only',name:'Configurations',description:'Invented configuration pack',matches:()=>true,configurationPresets:[{id:'invented-budget',name:'Invented budget',platformOverrides:{QueryLinkEntityLimit:30}}]};
  const {app}=await fixture(t,{packs:[pack]});
  const diagnostics=await (await fetch(app.url+'/__sim/api/diagnostics')).json();
  assert.ok(!diagnostics.diagnostics.some(row=>row.code.startsWith('PACK_CONFIGURATION_PRESET_')));
  const response=await fetch(app.url+'/__sim/api/experiments/invented-budget/apply',{method:'POST',headers:{'x-sim-csrf':app.state().csrf,'content-type':'application/json'},body:'{}'});
  assert.equal(response.status,200,await response.text());
  assert.equal((await (await fetch(app.url+'/__sim/api/status')).json()).activeConfigurationPreset.id,'invented-budget');
});

test('persona authorize requests reuse an ordered index and invalidate changed contacts',t=>{
  const report={groups:[{id:'members'}],personas:Array.from({length:5000},(_,i)=>({key:'p'+i,contactId:String(i),label:'Person '+(5000-i),group:'members'})),enabled:true};
  const users=report.personas.map(persona=>({contactId:persona.contactId,subject:'subject-'+persona.contactId}));
  const localeCompare=String.prototype.localeCompare,sort=Array.prototype.sort;
  let catalogueSorts=0;
  t.mock.method(String.prototype,'localeCompare',function(other,...options){
    assert.equal(options.length,0,'display comparisons must reuse the module collator rather than supply locales/options per comparison');
    return localeCompare.call(this,other);
  });
  // MockTracker rejects arrays as method targets, including Array.prototype.
  t.after(()=>{Array.prototype.sort=sort;});
  Array.prototype.sort=function(...args){
    if(this.length===5000)catalogueSorts++;
    return sort.apply(this,args);
  };
  const first=chooserReport(report,users),second=chooserReport(report,structuredClone(users));
  const index=chooserSelection(first).index;
  assert.equal(first,second);assert.equal(index.length,5000);
  assert.equal(index,chooserSelection(second,new URLSearchParams('q=Person')).index);
  assert.equal(index,chooserSelection(structuredClone(first)).index,'equal catalogue contents reuse ordering across report objects');
  assert.equal(catalogueSorts,1,'unchanged authorize queries sort the catalogue once');
  users[0].subject='changed';const changed=chooserReport(report,users);assert.notEqual(changed,first);
  assert.equal(chooserSelection(changed).index.find(entry=>entry.key==='p0').persona.subject,'changed');
  assert.equal(catalogueSorts,2,'a changed contact invalidates the cached index');
  const refreshed={...report,personas:report.personas.map(persona=>persona.key==='p0'?{...persona,label:'AAA'}:persona)};
  assert.equal(chooserSelection(chooserReport(refreshed,users)).index[0].key,'p0');
  assert.equal(catalogueSorts,3,'a changed catalogue invalidates display ordering');
  const start=performance.now(),direct=indexPersonaCatalog(report);
  assert.deepEqual(direct.slice(0,3).map(entry=>entry.persona.label),['Person 1','Person 10','Person 100']);
  t.diagnostic(`5000-person index build: ${(performance.now()-start).toFixed(2)} ms (informational; operation counts are asserted)`);
});

test('duplicate YAML reports every overwritten setting and its lines',async t=>{
  const {root}=await fixture(t);await fs.writeFile(path.join(root,'sitesetting.yml'),'- adx_name: Webapi/a/fields\n  adx_value: a\n  adx_name: Webapi/b/fields\n  adx_value: b\n  adx_name: Webapi/c/fields\n  adx_value: c\n');
  const portal=await importPortal(root),errors=portal.diagnostics.filter(row=>row.code==='duplicate-yaml-key');
  assert.equal(errors.length,2);assert.deepEqual(errors.map(row=>row.line),[3,5]);assert.match(errors[0].message,/Webapi\/a\/fields.*line 1.*Webapi\/b\/fields.*line 3/);
});

test('project confinement seeds new states and a saved runtime setting wins on restart',async t=>{
  const {app,settings,root}=await fixture(t,{contentPolicyDefaults:{confinePortalPages:true}});
  assert.equal(app.state().config.confinePortalPages,true);assert.match((await fetch(app.url+'/?id=one')).headers.get('content-security-policy'),/connect-src/);
  app.store.state.simulator.confinePortalPages=false;await app.store.compact();await app.close();
  const restarted=await createSimulator(settings);t.after(()=>restarted.close());assert.equal(restarted.state().config.confinePortalPages,false);
  const other=await createSimulator({...settings,stateFile:path.join(root,'default-state.json'),contentPolicyDefaults:{}});t.after(()=>other.close());assert.equal(other.state().config.confinePortalPages,false);
});

test('project confinement does not mutate shared initial state or leak defaults between runtimes',async t=>{
  const {root}=await fixture(t);
  const initial={settings:{permissionMode:'permissive'},simulator:{identity:{roles:[]}}},before=structuredClone(initial);
  const first=await createSimulator({sourceDir:root,initial,watch:false,contentPolicyDefaults:{confinePortalPages:true}});t.after(()=>first.close());
  assert.equal(first.state().config.confinePortalPages,true);
  assert.equal(first.state().config.contentPolicySource,'project defaults');
  assert.deepEqual(initial,before,'starting a runtime must not change caller-owned seed data');
  const second=await createSimulator({sourceDir:root,initial,watch:false,contentPolicyDefaults:{confinePortalPages:false}});t.after(()=>second.close());
  assert.equal(second.state().config.confinePortalPages,false);
  assert.equal(second.state().config.contentPolicySource,'project defaults');
  assert.deepEqual(initial,before);
});

test('project file policy defaults inherit per site and reach a catalogue-bound runtime',async t=>{
  const {root}=await fixture(t);await fs.mkdir(path.join(root,'web-pages'),{recursive:true});
  const projectFile=path.join(root,'project.json'),catalogue=path.join(root,'catalogue-policy.json');
  await fs.writeFile(projectFile,JSON.stringify({version:1,confinePortalPages:true,externalFrameOrigins:['https://frames.example.test/'],portals:[{id:'inherited',path:'.'},{id:'override',path:'.',confinePortalPages:false,externalFrameOrigins:[]}]}));
  const project=await loadProjectConfig(projectFile);
  assert.equal(project.portals[0].confinePortalPages,true);assert.equal(project.portals[1].confinePortalPages,false);
  assert.deepEqual(project.portals[0].externalFrameOrigins,['https://frames.example.test']);assert.deepEqual(project.portals[1].externalFrameOrigins,[]);
  await fs.writeFile(catalogue,JSON.stringify({sites:{invented:{source:root,environments:{local:'http://127.0.0.1:8787'},mirage:{project:'project.json'}}}}));
  const context=await createMirageContext({config:catalogue,site:'invented'}),app=await context.createSimulator({watch:false});t.after(()=>app.close());
  assert.equal(app.state().config.confinePortalPages,true);assert.equal(app.state().config.contentPolicySource,'project defaults');
  const response=await fetch(app.url);assert.match(response.headers.get('content-security-policy'),/frame-src 'self' https:\/\/frames\.example\.test/);
  await fs.writeFile(projectFile,JSON.stringify({version:1,confinePortalPages:'true',portals:[{id:'invalid',path:'.'}]}));
  await assert.rejects(loadProjectConfig(projectFile),/confinePortalPages must be true or false/);
});

test('sign-in request failures name their parameter without changing portal rendering errors',async t=>{
  const {app}=await fixture(t);const response=await fetch(app.url+'/_sim/sign-in?persona=absent');assert.equal(response.status,404);assert.match(await response.text(),/<title>Invalid persona parameter/);
});

test('runtime configuration link diagnostics are visible without hydrating a preset',async t=>{
  const pack={id:'invented',name:'Invented',description:'Synthetic links',matches:()=>true,configurationPresets:[],presets:()=>({broken:{name:'Broken',configurationPreset:'missing',load(){throw new Error('Keep lazy');}}})};
  const {app}=await fixture(t,{packs:[pack]});
  const diagnostics=await (await fetch(app.url+'/__sim/api/diagnostics')).json();
  assert.equal(JSON.stringify(diagnostics).match(/PACK_CONFIGURATION_PRESET_LINK_UNKNOWN/g)?.length,1);
  assert.ok(app.state().diagnostics.some(row=>row.code==='PACK_CONFIGURATION_PRESET_LINK_UNKNOWN'));
});

test('a site-bound context reuses its portal import and exposes effective Solution roots',async t=>{
  const {root}=await fixture(t);
  await fs.mkdir(path.join(root,'web-pages'),{recursive:true});
  const config=path.join(root,'catalogue.yml');await fs.writeFile(config,'sourceRoot: .\nsites:\n  sample:\n    source: .\n    environments:\n      local: http://127.0.0.1:8787\n');
  // importPortal resolves aliases such as Windows RUNNER~1 before reading. Count
  // its real file identity instead of the temporary directory's original spelling.
  const website=path.join(await fs.realpath(root),'website.yml'),read=fs.readFile;let imports=0;
  t.mock.method(fs,'readFile',(file,...args)=>{if(path.relative(website,String(file))===''&&args[0]==='utf8')imports++;return read(file,...args);});
  const context=await createMirageContext({config,site:'sample'}),app=await context.createSimulator({watch:false});t.after(()=>app.close());
  assert.equal(imports,1);
  const status=await (await fetch(app.url+'/__sim/api/status')).json();assert.deepEqual(app.state().status.solutionRoots,status.solutionRoots);
  const override=await context.createSimulator({sourceDir:root,watch:false});t.after(()=>override.close());assert.equal(imports,2);
});
