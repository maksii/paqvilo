import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {observedConfig} from '../lib/project-config.mjs';
import {createSimulator} from '../server.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";
const G=n=>'66666666-6666-4666-8666-'+String(n).padStart(12,'0');
async function fixture(t,{append=true,appendTo=true,manual=false,self=false,observed=null}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'paqvilo-intersect-rights-'));ownedFixture(t).remove(()=>fs.rm(root,{recursive:true,force:true}));
 const portal=path.join(root,'portal'),solution=path.join(root,'solution');await fs.mkdir(portal,{recursive:true});await fs.mkdir(path.join(solution,'Other'),{recursive:true});
 await fs.writeFile(path.join(portal,'website.yml'),'adx_name: Invented\nadx_websiteid: invented\n');
 await fs.writeFile(path.join(portal,'webrole.yml'),JSON.stringify([{adx_webroleid:G(1),adx_name:'Member'}]));
 await fs.writeFile(path.join(portal,'tablepermission.yml'),JSON.stringify(['widget','label'].map((entity,i)=>({adx_entitypermissionid:G(10+i),adx_entityname:entity,adx_entitylogicalname:entity,adx_scope:756150000,adx_entitypermission_webrole:[G(1)],adx_read:true,adx_write:true,adx_create:false,adx_delete:false,adx_append:entity==='widget'?append:false,adx_appendto:entity==='label'||self?appendTo:false}))));
 await fs.writeFile(path.join(portal,'sitesetting.yml'),JSON.stringify([{adx_name:'Webapi/error/innererror',adx_value:'true'},...['widget','label','widget_label'].flatMap(entity=>[{adx_name:'Webapi/'+entity+'/enabled',adx_value:'true'},{adx_name:'Webapi/'+entity+'/fields',adx_value:entity==='widget'?'widgetid,widget_labels':entity==='label'?'labelid':'widget_labelid,widgetid,labelid'}])]));
 for(const [entity,set]of[['widget','widgets'],['label','labels']]){await fs.mkdir(path.join(solution,'Entities',entity),{recursive:true});await fs.writeFile(path.join(solution,'Entities',entity,'Entity.xml'),'<Entity><Name>'+entity+'</Name><EntityInfo><entity Name="'+entity+'"><EntitySetName>'+set+'</EntitySetName><attributes><attribute PhysicalName="'+entity+'id"><Name>'+entity+'id</Name><Type>primarykey</Type></attribute></attributes></entity></EntityInfo></Entity>');}
 await fs.writeFile(path.join(solution,'Other/Relationships.xml'),'<EntityRelationships><EntityRelationship Name="widget_labels"><EntityRelationshipType>ManyToMany</EntityRelationshipType><FirstEntityName>widget</FirstEntityName><SecondEntityName>'+ (self?'widget':'label') +'</SecondEntityName><IntersectEntityName>widget_label</IntersectEntityName><Entity1IntersectAttribute>widgetid</Entity1IntersectAttribute><Entity2IntersectAttribute>labelid</Entity2IntersectAttribute><EntityRelationshipRoles><EntityRelationshipRole><AssociationRoleOrdinal>1</AssociationRoleOrdinal><NavigationPropertyName>widget_labels</NavigationPropertyName></EntityRelationshipRole><EntityRelationshipRole><AssociationRoleOrdinal>2</AssociationRoleOrdinal><NavigationPropertyName>label_widgets</NavigationPropertyName></EntityRelationshipRole></EntityRelationshipRoles></EntityRelationship></EntityRelationships>');
 const sim=await createSimulator({sourceDir:portal,solutionRoots:[solution],solutionOrder:'explicit',watch:false,port:0,observed});ownedFixture(t).add(()=>sim.close());
 await sim.store.transact(()=>{sim.store.state.tables.widget=[{widgetid:G(2)},...(self?[{widgetid:G(3)}]:[])];sim.store.state.tables.label=[{labelid:G(3)}];sim.store.state.tables.contact=[{contactid:G(4),fullname:'Invented member',statecode:0}];if(manual==='untyped'){delete sim.store.state.mappings.widget.relationships.widget_labels.schemaName;delete sim.store.state.mappings.widget.relationships.widget_labels.type;}else if(manual)sim.store.state.mappings.widget_label.userConfigured=true;});
 const signed=sim.signIn(G(4),{roles:['Member']}),cookie=signed.cookieHeader,endpoint='/_api/widgets('+G(2)+')/widget_labels';
 const call=(route,{method='GET',body}={})=>fetch(sim.url+route,{method,headers:{cookie,__RequestVerificationToken:sim.state().csrf,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 return {sim,identity:signed.identity,call,endpoint,post:()=>call(endpoint+'/$ref',{method:'POST',body:{'@odata.id':sim.url+'/_api/'+(self?'widgets':'labels')+'('+G(3)+')'}}),remove:()=>call(endpoint+'('+G(3)+')/$ref',{method:'DELETE'}),edge:()=>sim.store.state.tables.widget_label};
}
test('imported intersect associations use endpoint grants, idempotent native HTTP writes and exact readbacks',async t=>{
 const f=await fixture(t);assert.equal(f.sim.store.state.mappings.widget_label.intersect,true);assert.equal(f.sim.store.state.mappings.widget.relationships.widget_labels.schemaName,'widget_labels');assert.equal(f.sim.store.state.mappings.widget.relationships.widget_labels.type,'many-to-many');
 for(let i=0;i<2;i++){const r=await f.post();assert.equal(r.status,204,await r.text());assert.equal(f.edge().length,1);}
 const read=await f.call('/_api/widgets('+G(2)+')?$select=widgetid&$expand=widget_labels($select=labelid)');assert.equal(read.status,200);assert.deepEqual((await read.json()).widget_labels.map(r=>r.labelid),[G(3)]);
 const direct=await f.call('/_api/widget_labels('+f.edge()[0].widget_labelid+')',{method:'DELETE'});assert.equal(direct.status,403);assert.equal(f.edge().length,1);
 for(let i=0;i<2;i++){const r=await f.remove();assert.equal(r.status,204,await r.text());assert.equal(f.edge().length,0);}
 const directCreate=await f.call('/_api/widget_labels',{method:'POST',body:{widgetid:G(2),labelid:G(3)}});assert.equal(directCreate.status,403);assert.equal(f.edge().length,0);
});
test('false source Append and false target AppendTo deny association and disassociation without changing links',async t=>{
 for(const [append,appendTo]of[[false,true],[true,false],[false,false]]){
  const f=await fixture(t,{append,appendTo});const denied=await f.post();assert.equal(denied.status,403,await denied.text());assert.equal(f.edge().length,0);
  await f.sim.store.transact(()=>{f.edge().push({widget_labelid:G(20),widgetid:G(2),labelid:G(3)});});const before=structuredClone(f.edge()),remove=await f.remove();assert.equal(remove.status,403,await remove.text());assert.deepEqual(f.edge(),before);
 }
});
test('explicitly configured edge mappings retain their own create/delete permission boundary',async t=>{
 for(const manual of[true,'untyped']){const f=await fixture(t,{manual});const denied=await f.post();assert.equal(denied.status,403);assert.equal(f.edge().length,0);}
});

test('qualified self N:N portal denials preserve the exact observed envelope for each missing flag',async t=>{
 const profile={webApiInnerError:'all-errors',webApiSelfNnPermissionErrors:{widget_labels:'native-classic'},evidence:'Invented self N:N denial qualification'};
 for(const[append,appendTo]of[[false,true],[true,false],[false,false]]){
  const f=await fixture(t,{self:true,append,appendTo,observed:profile}),r=await f.post();
  assert.equal(r.status,403);const message='You don’t have permission to associate or disassociate table widget to widget';assert.deepEqual(await r.json(),{error:{code:'90040106',message,innererror:{code:'90040106',message,type:'EntityPermissionAppendToIsMissingDuringAssociationChange'}}});assert.equal(f.edge().length,0);
 }
 const sdk=await fixture(t,{self:true,append:false,observed:profile});await assert.rejects(sdk.sim.store.transact(()=>sdk.sim.store.changeAssociationRecord('widget',G(2),'widget_labels',G(3),sdk.identity,true)),error=>error.code==='PermissionDenied'&&error.details.operation==='append'&&!error.details.portalSelfNnAssociation);
 const defaultSelf=await fixture(t,{self:true,append:false});assert.equal((await(await defaultSelf.post()).json()).error.code,'90040105');
 const otherSchema=await fixture(t,{self:true,append:false,observed:{...profile,webApiSelfNnPermissionErrors:{other_relation:'native-classic'}}});assert.equal((await(await otherSchema.post()).json()).error.code,'90040105');
 const otherTable=await fixture(t,{append:false,observed:profile});assert.equal((await(await otherTable.post()).json()).error.code,'90040105');
});

test('self N:N denial observations require evidence and explicit unique relationship schemas',()=>{
 assert.throws(()=>observedConfig({webApiSelfNnPermissionErrors:{widget_labels:'native-classic'}}),/evidence/);
 for(const value of['native-classic',{},[],{widget_labels:'unknown'},{'bad/path':'native-classic'},{widget_labels:'native-classic',WIDGET_LABELS:'native-classic'}])assert.throws(()=>observedConfig({webApiSelfNnPermissionErrors:value,evidence:'Invented qualification'}),/webApiSelfNnPermissionErrors/);
 assert.equal(observedConfig({webApiSelfNnPermissionErrors:{Widget_Labels:'native-classic'},evidence:'Invented qualification'}).webApiSelfNnPermissionErrors.widget_labels,'native-classic');
});
