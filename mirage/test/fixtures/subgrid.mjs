import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createSimulator} from '../../server.mjs';
export const parentId='11111111-1111-1111-1111-111111111111';
export const otherParentId='22222222-2222-2222-2222-222222222222';
export const pendingId='33333333-3333-3333-3333-333333333333';
export const acceptedId='44444444-4444-4444-4444-444444444444';
export const foreignId='55555555-5555-5555-5555-555555555555';
export function model(){
  const filter='<fetch><entity name="child"><filter><condition attribute="status" operator="eq" value="2"/></filter></entity></fetch>';
  const settings={ViewActions:[{Type:'CrmEntityFormView-CreateAction',RedirectWebpageId:'add',ButtonLabel:[{LCID:1033,Value:'<svg data-source-icon></svg>Add child'}]}],ItemActions:[{Type:'CrmEntityFormView-EditAction',EntityFormId:'notify',Label:'Notify',FilterCriteria:filter},{Type:'CrmEntityFormView-DeleteAction',Label:'Remove',FilterCriteria:filter}],ColumnOverrides:[{AttributeLogicalName:'name',DisplayName:'Child name'}]};
  settings.ViewActions[0].TargetType=1;
  settings.ViewActions[0].EntityFormId='notify'; // Stale field remains in actual PAC records.
  const portal={website:{id:'site'},forms:[{id:'parent',name:'Parent',mode:100000001},{id:'notify',name:'Notify',mode:100000001}],pages:[{id:'add',url:'/add/'}],records:[{adx_entityform:'parent',adx_subgrid_name:'Children',adx_subgrid_settings:JSON.stringify(settings)}]};
  const schemas={parent:{entity:'parent',mode:100000001,fields:[{name:'name',label:'Parent name'}],layout:[{name:'tab',columns:[{sections:[{name:'section',rows:[[{name:'name'},{id:'Children',type:'subgrid',relationship:'children',entity:'child',fields:[{name:'name'}],fetchXml:'<fetch><entity name="child"><attribute name="childkey"/><attribute name="name"/></entity></fetch>'}]]}]}]}]},notify:{entity:'child',mode:100000001,fields:[{name:'message',label:'Message'}]}};
  const state={mappings:{parent:{entitySet:'parents',idColumn:'parentkey',relationships:{children:{entity:'child',from:'parentkey',to:'parentlookup',many:true}}},child:{entitySet:'children',idColumn:'childkey',nameColumn:'name'}},tables:{parent:[{parentkey:parentId,name:'First parent'},{parentkey:otherParentId,name:'Other parent'}],child:[{childkey:pendingId,parentlookup:parentId,name:'Pending child',status:2,message:'Old message'},{childkey:acceptedId,parentlookup:parentId,name:'Accepted child',status:1},{childkey:foreignId,parentlookup:otherParentId,name:'Foreign child',status:2}]},permissions:['parent','child'].map(entity=>({id:'editor-'+entity,entity,scope:'global',roles:['Editor'],operations:['read','create','update','delete']})),settings:{permissionMode:'enforce'},simulator:{mode:'local',pageMode:'local',identity:{id:'editor',roles:['Editor']},componentSchemas:schemas,endpoints:[],live:{origin:null}}};
  return {portal,schemas,state,settings};
}
export async function simulatorFixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'native-grid-'));
  const {state,settings}=model();
  const files={
    'website.yml':'adx_websiteid: site\nadx_name: Test',
    'Home.webpage.yml':'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml':'adx_pagetemplateid: template\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'Main.webtemplate.yml':'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html':'{% entityform name: "Parent" %}<script>window.gridLoads=0;document.getElementById("Children").addEventListener("loaded",()=>window.gridLoads++);</script>',
    'Parent.basicform.yml':'adx_entityformid: parent\nadx_name: Parent\nadx_entityname: parent\nadx_mode: 100000001',
    'Notify.basicform.yml':'adx_entityformid: notify\nadx_name: Notify\nadx_entityname: child\nadx_mode: 100000001',
    'Parent.basicform.basicformmetadata.yml':`adx_entityform: parent\nadx_subgrid_name: Children\nadx_subgrid_settings: ${JSON.stringify(JSON.stringify(settings))}`,
    'Add.webpage.yml':'adx_webpageid: add\nadx_name: Add\nadx_partialurl: add\nadx_parentpageid: home\nadx_pagetemplateid: template',
  };
  // Fixture event bridge exercises authored listeners without a portal dependency.
  const bridge='<script>window.jQuery=(target)=>({trigger:name=>{const nodes=typeof target==="string"?document.querySelectorAll(target):[target];for(const node of nodes)node.dispatchEvent(new Event(name));}});window.jQuery.fn={load(){}};</script>';
  files['Main.webtemplate.source.html']=bridge+files['Main.webtemplate.source.html'];
  for(const [name,contents]of Object.entries(files))await fs.writeFile(path.join(directory,name),contents);
  const app=await createSimulator({sourceDir:directory,stateFile:path.join(directory,'state.json'),initial:state,watch:false});
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  return app;
}
