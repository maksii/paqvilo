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

test('deferred query execution preserves infrastructure errors and requires explicit evidence',async()=>{
  assert.throws(()=>observedConfig({liquidFetchExecution:'lazy-query-drop'}),/evidence/);
  const failure=new Error('Owned SDK host unavailable');
  failure.infrastructure=true;
  const renderer=createPortalRenderer(portal,{observed:observation,previewFetchXml:()=>({xml:query}),fetchXml:()=>{throw failure;}});
  await assert.rejects(()=>renderer.renderString(tag+'{{found.results}}'),/Owned SDK host unavailable/);
});
