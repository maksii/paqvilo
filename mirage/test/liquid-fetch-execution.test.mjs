import test from 'node:test';
import assert from 'node:assert/strict';
import {createPortalRenderer} from '../lib/liquid.mjs';
import {DataError,DataStore} from '../lib/data.mjs';
import {observedConfig} from '../lib/project-config.mjs';

const portal={templates:{},snippets:{},settings:{},pages:[],webFiles:[],lists:[],entityForms:[],advancedForms:[]};
const observation=observedConfig({liquidFetchExecution:'lazy-query-drop',liquidFetchErrorMessage:'target-invocation',tablePermissionQueryPipeline:'native-classic',evidence:'Invented deferred query-drop contracts; native timing requires separate qualification'});
const query='<fetch><entity name="widget"><attribute name="widgetid"/></entity></fetch>';
const tag=`{% fetchxml found %}${query}{% endfetchxml %}`;

test('opt-in query drop previews XML without backend work and caches one result execution',async()=>{
  const store=new DataStore({state:{mappings:{widget:{entitySet:'widgets',idColumn:'widgetid'}},tables:{widget:[{widgetid:'one',owner:'person'}]},permissions:[{entity:'widget',scope:'contact',field:'owner',roles:['Reader'],operations:['read']}],settings:{permissionMode:'enforce'}}});
  const identity={contactId:'person',roles:['Reader']};store.setObserved(observation);let calls=0;
  const renderer=createPortalRenderer(portal,{observed:observation,previewFetchXml:xml=>store.previewPermissionFetchXml(xml,identity),fetchXml:xml=>{calls++;return store.fetchXml(xml,identity,{portalRequest:true});}});
  const preview=await renderer.renderString(tag+'{{found.xml}}');assert.match(preview,/distinct="true"/);assert.equal(calls,0);
  const result=await renderer.renderString(tag+'{{found.results.entities[0].widgetid}}|{{found.results.entities.size}}|{{found.results.more_records}}');
  assert.equal(result,'one|1|false');assert.equal(calls,1);
});

test('failed deferred results remain cached while the independently compiled XML stays readable',async()=>{
  let calls=0;
  const renderer=createPortalRenderer(portal,{observed:observation,previewFetchXml:()=>({xml:'compiled-query',permissionGranted:true}),fetchXml:()=>{calls++;throw new DataError('Query budget exceeded',400,'UnsupportedQuery');}});
  const result=await renderer.renderString(tag+'<outcome>{% if found.results ==nil %}none{% else %}success{% endif %}</outcome><rows>{{found.results.entities.size}}</rows><xml>{{found.xml}}</xml>');
  assert.equal(calls,1);
  assert.equal(result,'<outcome>Liquid error: Exception has been thrown by the target of an invocation.</outcome><rows>Liquid error: Exception has been thrown by the target of an invocation.</rows><xml>compiled-query</xml>');
});

test('deferred XML uses the same scoped DISTINCT, authored link conversion and alias allocation as execution',async()=>{
  const store=new DataStore({state:{mappings:{widget:{entitySet:'widgets',idColumn:'widgetid'},principal:{entitySet:'principals',idColumn:'principalid'}},
    tables:{widget:[{widgetid:'one',ownerid:'p1'}],principal:[{principalid:'p1',owner:'person'}]},
    permissions:[{id:'anchor',entity:'principal',scope:'contact',field:'owner',roles:['Reader'],operations:['read']},
      {id:'child',entity:'widget',scope:'parent',parentPermissionId:'anchor',relationship:{entity:'principal',from:'ownerid',to:'principalid'},roles:['Reader'],operations:['read']}],settings:{permissionMode:'enforce'}}});
  const identity={contactId:'person',roles:['Reader']},observed={...observation,liquidFetchXmlLinkTypes:'portal-classic'};
  store.setObserved(observed);let executed,calls=0;
  const renderer=createPortalRenderer(portal,{observed,previewFetchXml:xml=>store.previewPermissionFetchXml(xml,identity),fetchXml:xml=>{calls++;executed=store.fetchXml(xml,identity,{portalRequest:true});return executed;}});
  const source='<fetch distinct="false"><entity name="widget"><attribute name="widgetid"/><link-entity name="principal" from="principalid" to="ownerid" alias="joined" link-type="exists"/></entity></fetch>';
  const output=await renderer.renderString('{% fetchxml found %}'+source+'{% endfetchxml %}<before>{{found.xml}}</before><size>{{found.results.entities.size}}</size><after>{{found.xml}}</after>');
  const before=output.match(/<before>([\s\S]*?)<\/before>/)[1],after=output.match(/<after>([\s\S]*?)<\/after>/)[1];
  assert.equal(calls,1);assert.equal(before,executed.xml);assert.equal(after,executed.xml);
  assert.match(before,/distinct="true"/);assert.doesNotMatch(before,/link-type="exists"/);
  assert.match(before,/alias="generated_alias_principal_1"/);assert.equal(executed.permissionQuery.permissionLinkCount,1);
  assert.equal(executed.permissionQuery.authoredLinkCount,1);assert.match(output,/<size>1<\/size>/);
});

test('deferred query execution preserves infrastructure errors and requires explicit evidence',async()=>{
  assert.throws(()=>observedConfig({liquidFetchExecution:'lazy-query-drop'}),/evidence/);
  const failure=new Error('Owned SDK host unavailable');
  failure.infrastructure=true;
  const renderer=createPortalRenderer(portal,{observed:observation,previewFetchXml:()=>({xml:query}),fetchXml:()=>{throw failure;}});
  await assert.rejects(()=>renderer.renderString(tag+'{{found.results}}'),/Owned SDK host unavailable/);
});

test('native invalid Liquid filter links retain readable rewritten XML and fail only when deferred results execute',async()=>{
  const store=new DataStore({state:{mappings:{widget:{entitySet:'widgets',idColumn:'widgetid'}},tables:{widget:[]},permissions:[{entity:'widget',scope:'global',roles:['Reader']}],settings:{permissionMode:'enforce'}}});
  const observed={...observation,liquidFetchXmlLinkTypes:'portal-classic'},identity={roles:['Reader']};store.setObserved(observed);let calls=0;
  const stages=[];store.setPluginPipeline(event=>stages.push(event.stage),()=>true);
  const renderer=createPortalRenderer(portal,{observed,previewFetchXml:xml=>store.previewPermissionFetchXml(xml,identity),fetchXml:xml=>{calls++;return store.fetchXml(xml,identity,{portalRequest:true});}});
  const error='Liquid error: Exception has been thrown by the target of an invocation.';
  for(const type of ['not any','all','not all']){
    const source='<fetch><entity name="widget"><attribute name="widgetid"/><filter><link-entity name="widget" from="widgetid" to="widgetid" link-type="'+type+'"/></filter></entity></fetch>';
    const output=await renderer.renderString('{% fetchxml found %}'+source+'{% endfetchxml %}<xml>{{found.xml}}</xml><rows>{{found.results.entities.size}}</rows><again>{{found.xml}}</again>');
    const expected=store.previewPermissionFetchXml(source,identity).xml;
    assert.equal(output,'<xml>'+expected+'</xml><rows>'+error+'</rows><again>'+expected+'</again>');
    assert.doesNotMatch(expected,/link-type=/);assert.match(expected,/<link-entity/);
  }
  assert.equal(calls,3);assert.deepEqual(stages,[10,20,10,20,10,20]);
});
