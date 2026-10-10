import test from 'node:test';
import assert from 'node:assert/strict';
import {DataStore} from '../lib/data.mjs';
import {renderComponent} from '../lib/platform.mjs';
import {deletePortalSubgridRecord,subgridActionUrl} from '../lib/subgrid-actions.mjs';
import {subgridModel,gridData,formCells} from '../lib/native-services.mjs';
import {model,simulatorFixture,parentId,pendingId,acceptedId,foreignId} from './fixtures/subgrid.mjs';

test('configured native dataset PCF is diagnosed rather than silently presented as a supported native grid', async () => {
  const {portal,schemas,state}=model(),store=await new DataStore({state}).init(),diagnostics=[];
  portal.records[0].adx_type=100000003;
  portal.records[0].kind='basicformmetadata';
  portal.records[0].adx_controlstyle=756150001;
  const context={request:{url:'http://localhost/?id='+parentId,params:{id:parentId}},user:state.simulator.identity};
  const html=await renderComponent('entityform','Parent',context,{portal,store,schemas,diagnostic:entry=>diagnostics.push(entry)});
  assert.match(html,/hosted relationship binding is not implemented locally/);
  assert.ok(diagnostics.some(entry=>entry.code==='PCF_NATIVE_DATASET_UNSUPPORTED'));
  assert.match(html,/data-ref-id="11111111-1111-1111-1111-111111111111"/);
  portal.lists=[{id:'children-list',name:'Children list',entityName:'child',metadata:{adx_iscodecomponent:true}}];
  schemas['children-list']={entity:'child',fields:[{name:'name'}]};
  const list=await renderComponent('entitylist','Children list',{...context,key:'Children list'},{portal,store,schemas,args:{key:'Children list'},diagnostic:entry=>diagnostics.push(entry)});
  assert.match(list.html,/hosted list binding is not implemented locally/);
  assert.ok(diagnostics.some(entry=>entry.component==='entitylist'&&entry.code==='PCF_NATIVE_DATASET_UNSUPPORTED'));
});

test('subgrid quick search derives from the exported form control and filters related rows only', async () => {
  const {portal,schemas,state}=model();
  const cell=formCells(schemas.parent).find(cell=>cell.id==='Children');
  cell.searchEnabled=true;cell.recordsPerPage=4;
  const store=await new DataStore({state}).init(),identity=state.simulator.identity;
  const html=await renderComponent('entityform','Parent',{request:{url:'http://localhost/?id='+parentId,params:{id:parentId}},user:identity},{portal,store,schemas});
  const start=html.indexOf('class="entity-grid subgrid');
  const [layout]=JSON.parse(Buffer.from(/data-view-layouts="([^"]*)"/.exec(html.slice(start))[1],'base64').toString('utf8'));
  assert.equal(layout.Configuration.Search.Enabled,true);
  assert.equal(layout.Configuration.PageSize,4);
  const grid=subgridModel({portal,schemas,metadata:{},store,kind:'entityform',formId:'parent',gridId:'Children'});
  const data=await gridData(grid,{page:1,pageSize:4,search:'Pend'},{portal,store,readProvider:store,identity,metadata:{},config:{mode:'local'},secure:{t:'subgrid',parent:parentId,view:grid.views[0].id}});
  assert.deepEqual(data.Records.map(record=>record.Id),[pendingId]);
  cell.searchEnabled=false;
  assert.equal(subgridModel({portal,schemas,metadata:{},store,kind:'entityform',formId:'parent',gridId:'Children'}).search.enabled,false);
});
import {signInHeaders} from '../testing/session.mjs';

test('exported grid redirects, labels and row filters retain source actions and declared permissions',async()=>{
  const layoutsOf = (html) => {
  const start = html.indexOf('class="entity-grid subgrid');
  const encoded = /data-view-layouts="([^"]*)"/.exec(html.slice(start))[1];
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
};
  const {portal,schemas,state}=model(),store=await new DataStore({state}).init(),identity=state.simulator.identity;
  const html=await renderComponent('entityform','Parent',{request:{url:'http://localhost/?id='+parentId,params:{id:parentId}},user:identity},{portal,store,schemas});
  // Native subgrid shell: relationship reference attributes and configuration-only layouts.
  assert.match(html,new RegExp('<div id="Children" class="subgrid"><div class="entity-grid subgrid" [^>]*data-ref-entity="parent" data-ref-id="'+parentId+'" data-ref-rel="children"'));
  assert.doesNotMatch(html,/Pending child|Accepted child|Foreign child/);
  const [layout]=layoutsOf(html);
  const create=layout.Configuration.ViewActionLinks[0];
  // A web-page create target keeps its redirect URL; the client appends refentity/refid/refrel.
  assert.deepEqual([create.Type,create.Target,create.URL.PathWithQueryString,create.Label],[3,1,'/add/','<svg data-source-icon></svg>Add child']);
  assert.equal(layout.Columns.find(column=>column.LogicalName==='name').Name,'Child name');
  assert.deepEqual(layout.Configuration.ItemActionLinks.map(action=>[action.Type,action.Label,action.EntityForm?.Id??null]),[[2,'Notify','notify'],[4,'Remove',null]]);
  assert.equal(layout.Columns.at(-1).LogicalName,'col-action');
  // Rows and per-row action filters come from the native subgrid data service.
  const grid=subgridModel({portal,schemas,metadata:{},store,kind:'entityform',formId:'parent',gridId:'Children'});
  const data=await gridData(grid,{page:1,pageSize:10,sortExpression:''},{portal,store,readProvider:store,identity,metadata:{},config:{mode:'local'},secure:{t:'subgrid',parent:parentId,view:grid.views[0].id}});
  assert.deepEqual(data.Records.map(record=>record.Id).sort(),[pendingId,acceptedId].sort());
  assert.ok(data.Records.every(record=>record.CanRead&&record.CanWrite&&record.CanDelete));
  assert.equal(data.DisabledItemActionLinks.length,2);
  assert.ok(data.DisabledItemActionLinks.every(entry=>entry.EntityId===acceptedId));
  assert.deepEqual(new Set(data.DisabledItemActionLinks.map(entry=>entry.LinkUniqueId)),new Set(layout.Configuration.ItemActionLinks.map(action=>action.FilterCriteriaId)));
  const name=data.Records[0].Attributes.find(attribute=>attribute.Name==='name');
  assert.equal(name.Type,'System.String');
  assert.throws(()=>subgridActionUrl({RedirectUrl:'javascript:alert(1)'},{portal,parentId,requestUrl:'http://localhost/'}),e=>e.code==='SUBGRID_REDIRECT_INVALID');
});

test('native grid deletes reject unrelated rows, immutable action-filter failures and denied identities',async()=>{
  const {portal,schemas,state}=model(),store=await new DataStore({state}).init(),identity=state.simulator.identity;
  const options={portal,store,schemas,identity};
  await assert.rejects(deletePortalSubgridRecord('entityform','parent','Children',foreignId,{parentId},options),e=>e.code==='SubgridRowNotRelated');
  await assert.rejects(deletePortalSubgridRecord('entityform','parent','Children',acceptedId,{parentId},options),e=>e.code==='SubgridDeleteNotEnabled');
  await assert.rejects(deletePortalSubgridRecord('entityform','parent','Other',pendingId,{parentId},options),e=>e.code==='SubgridNotBound');
  await assert.rejects(deletePortalSubgridRecord('entityform','parent','Children',pendingId,{parentId},{...options,identity:{roles:[]}}),e=>e.status===403);
  assert.equal(store.snapshot().tables.child.length,3);
  assert.deepEqual(await deletePortalSubgridRecord('entityform','parent','Children',pendingId,{parentId},options),{deleted:true,id:pendingId});
  assert.equal(store.snapshot().tables.child.length,2);
});

test('HTTP native grid services enforce CSRF, declared actions and relationship scope independent of Web API settings',async t=>{
  const layoutsOf = (html) => {
  const start = html.indexOf('class="entity-grid subgrid');
  const encoded = /data-view-layouts="([^"]*)"/.exec(html.slice(start))[1];
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
};
  const app=await simulatorFixture(t);
  // Portal requests are signed in explicitly as the fixture's Editor persona.
  const session=signInHeaders(app,'editor',{roles:['Editor']});
  const page=await (await fetch(app.url+'/?id='+parentId,{headers:session})).text();
  const secure=layoutsOf(page)[0].Base64SecureConfiguration;
  const call=(action,body,headers={__RequestVerificationToken:app.state().csrf})=>fetch(app.url+'/_services/'+action+'/site',{method:'POST',headers:{'Content-Type':'application/json',...session,...headers},body:JSON.stringify(body)});
  assert.equal((await fetch(app.url+'/_api/children')).status,404);
  const request={base64SecureConfiguration:secure,sortExpression:'',search:'',page:1,pageSize:10,pagingCookie:'',filter:null,metaFilter:null,nlSearchFilter:'',timezoneOffset:0,customParameters:[]};
  assert.equal((await call('entity-subgrid-data.json',request,{})).status,403);
  let response=await call('entity-subgrid-data.json',request);
  assert.equal(response.status,200);
  const data=await response.json();
  assert.deepEqual(Object.keys(data),['MoreRecords','Records','ItemCount','PageCount','PageNumber','PageSize','NextPagePagingCookie','ViewConfiguration','CompleteViewLayout','CreateActionMetadata','DisabledItemActionLinks']);
  assert.deepEqual([data.ItemCount,data.PageCount,data.PageNumber,data.PageSize,data.MoreRecords],[2,1,1,10,false]);
  // The configuration is opaque and signed; a tampered blob or another endpoint kind is refused.
  response=await call('entity-subgrid-data.json',{...request,base64SecureConfiguration:Buffer.from('{"t":"subgrid","w":"site"}.forged').toString('base64')});
  assert.equal(response.status,403);
  response=await call('entity-grid-data.json',request);
  assert.equal(response.status,403);
  const remove=(id,headers)=>call('entity-grid-delete',{LogicalName:'child',Id:id,base64SecureConfiguration:secure},headers);
  assert.equal((await remove(pendingId,{})).status,403);
  assert.equal((await remove(foreignId)).status,403);
  assert.equal((await remove(acceptedId)).status,403);
  assert.equal((await remove(pendingId)).status,204);
  assert.equal(app.store.snapshot().tables.child.length,2);
});

test('advanced grid actions bind the selected exported step and live deletes use upstream reads without local mutations',async()=>{
  const {portal,schemas,state}=model(),store=await new DataStore({state}).init(),identity=state.simulator.identity;
  portal.advancedForms=[{id:'wizard',name:'Wizard'}];
  portal.records[0].adx_webformstep='selected';delete portal.records[0].adx_entityform;
  schemas.wizard={initialStepId:'selected',steps:[{...schemas.parent,stepId:'selected'},{entity:'parent',stepId:'other',fields:[]}]};
  const calls=[],upstream={
    get:async(entity,id,user)=>{calls.push({operation:'get',entity,id,user});return entity==='parent'?{parentkey:parentId}:{childkey:pendingId,parentlookup:parentId,status:2};},
    fetchXml:async(xml,user)=>{calls.push({operation:'fetchXml',xml,user});return{entities:[{childkey:pendingId}]};},
  };
  const writeProvider={delete:async(entity,id,user)=>calls.push({operation:'delete',entity,id,user})};
  const options={portal,store,schemas,identity,readProvider:upstream,writeProvider};
  await assert.rejects(deletePortalSubgridRecord('webform','wizard','Children',pendingId,{parentId,stepId:'other'},options),e=>e.code==='SubgridNotBound');
  assert.equal(calls.length,0);
  await deletePortalSubgridRecord('webform','wizard','Children',pendingId,{parentId,stepId:'selected'},options);
  assert.equal(calls.at(-1).operation,'delete');
  assert.equal(calls.at(-1).entity,'child');
  assert.equal(calls.at(-1).id,pendingId);
  assert.ok(calls.every(call=>call.user===identity));
  assert.equal(store.snapshot().tables.child.length,3);
});

test('native grid action filters use the current exported website context',async()=>{
  const {portal,schemas,state,settings}=model();
  state.tables.child[0].site='site';
  settings.ItemActions[1].FilterCriteria=settings.ItemActions[1].FilterCriteria.replace('<filter>','<filter><condition attribute="site" operator="eq" uitype="adx_website" value="source-design-placeholder"/>');
  portal.records[0].adx_subgrid_settings=JSON.stringify(settings);
  const store=await new DataStore({state}).init();
  await deletePortalSubgridRecord('entityform','parent','Children',pendingId,{parentId},{portal,store,schemas,identity:state.simulator.identity});
  assert.equal(store.snapshot().tables.child.length,2);
});
