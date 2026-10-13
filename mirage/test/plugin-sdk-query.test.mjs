import test from 'node:test';
import assert from 'node:assert/strict';
import {DataStore} from '../lib/data.mjs';
import {dispatchSdkCall,recordToSdkEntity} from '../lib/plugin-clr.mjs';
const user='10000000-0000-0000-0000-000000000001',rootId='20000000-0000-0000-0000-000000000001',childId='30000000-0000-0000-0000-000000000001',leafId='40000000-0000-0000-0000-000000000001';
const profile={userId:user,evidence:'Invented linked-query backend',grants:['root','child','leaf'].map(entity=>({entity,operations:['read']}))};
const data=()=>new DataStore({state:{version:1,mappings:{root:{entitySet:'roots',idColumn:'rootid',fields:{title:{type:'string'}}},child:{entitySet:'children',idColumn:'childid',fields:{rootid:{type:'uniqueidentifier'},amount:{type:'money'}}},leaf:{entitySet:'leaves',idColumn:'leafid',fields:{childid:{type:'uniqueidentifier'},flag:{type:'choice'}}}},tables:{root:[{rootid:rootId,title:'Parent'}],child:[{childid:childId,rootid:rootId,amount:12.5}],leaf:[{leafid:leafId,childid:childId,flag:2}]},permissions:[],plugins:[],settings:{permissionMode:'enforce'}}});
const query=()=>({$type:'QueryExpression',entityName:'root',columnSet:{allColumns:false,columns:['title']},criteria:{operatorName:'And',conditions:[]},linkEntities:[{$type:'LinkEntity',linkFromEntityName:'root',linkToEntityName:'child',linkFromAttributeName:'rootid',linkToAttributeName:'rootid',entityAlias:'joined',joinOperator:'Inner',columns:{columns:['amount']},linkCriteria:{operatorName:'And',conditions:[{attributeName:'amount',operatorName:'GreaterThan',values:[{$type:'Decimal',value:'10.0'}]}]},linkEntities:[{$type:'LinkEntity',linkFromEntityName:'child',linkToEntityName:'leaf',linkFromAttributeName:'childid',linkToAttributeName:'childid',entityAlias:'nested',joinOperator:'LeftOuter',columns:{columns:['flag']}}]}]});
const run=(store,q,p=profile)=>dispatchSdkCall({store,profile:p,message:{method:'RetrieveMultiple',userId:user,arguments:[q]}});
test('Unlinked SDK QueryExpression and QueryByAttribute reach observers without reconstruction or extra identity columns',()=>{
 for(const source of [
  {$type:'QueryExpression',entityName:'root',columnSet:{allColumns:false,columns:['title']},criteria:{operatorName:'And',conditions:[{attributeName:'rootid',operatorName:'Equal',values:[{$type:'Guid',value:rootId}]}]}},
  {$type:'QueryByAttribute',entityName:'root',columnSet:{allColumns:false,columns:['title']},attributes:['rootid'],values:[{$type:'Guid',value:rootId}]},
 ]){
  const store=data(),seen=[];store.setPluginPipeline(c=>seen.push(structuredClone(c.query)),c=>c.operation==='retrievemultiple');
  const result=run(store,source);assert.deepEqual(seen,[source,source,source]);assert.equal(result.entities[0].id,rootId);assert.deepEqual(result.entities[0].attributes,{title:'Parent'});
 }
});
test('Nested SDK QueryExpression joins retain identity, projected columns and typed AliasedValue results',()=>{
 const store=data(),q=query(),before=structuredClone(q),answer=run(store,q),entity=answer.entities[0];assert.deepEqual(q,before);assert.equal(entity.id,rootId);assert.deepEqual(entity.attributes.title,'Parent');assert.ok(!Object.hasOwn(entity.attributes,'rootid'));assert.deepEqual(entity.attributes['joined.amount'],{$type:'AliasedValue',entityLogicalName:'child',attributeLogicalName:'amount',value:{$type:'Money',value:'12.5'}});assert.deepEqual(entity.attributes['nested.flag'],{$type:'AliasedValue',entityLogicalName:'leaf',attributeLogicalName:'flag',value:{$type:'OptionSetValue',value:2}});
});
test('Original FetchExpression aliases and aggregate aliases use typed SDK projection, with hidden primary identity',()=>{
 const store=data(),fetch={$type:'FetchExpression',query:'<fetch><entity name="root"><attribute name="title" alias="label"/><link-entity name="child" from="rootid" to="rootid" alias="c"><attribute name="amount"/></link-entity></entity></fetch>'},answer=run(store,fetch);assert.equal(answer.entities[0].id,rootId);assert.deepEqual(answer.entities[0].attributes.label,{$type:'AliasedValue',entityLogicalName:'root',attributeLogicalName:'title',value:'Parent'});assert.ok(!Object.hasOwn(answer.entities[0].attributes,'rootid'));
 const aggregate=run(store,{$type:'FetchExpression',query:'<fetch aggregate="true"><entity name="child"><attribute name="amount" alias="total" aggregate="sum"/></entity></fetch>'});assert.equal(aggregate.entities[0].id,'00000000-0000-0000-0000-000000000000');assert.deepEqual(aggregate.entities[0].attributes.total,{$type:'AliasedValue',entityLogicalName:'child',attributeLogicalName:'amount',value:{$type:'Money',value:'12.5'}});
});
test('SDK linked table grants and predicates filter original root and child rows before projection',()=>{
 const store=data(),q=query();assert.throws(()=>run(store,q,{...profile,grants:profile.grants.filter(g=>g.entity!=='leaf')}),/denied read on leaf/);const restricted={...profile,grants:profile.grants.map(g=>g.entity==='child'?{...g,predicate:row=>row.amount<10}:g)};assert.deepEqual(run(store,q,restricted).entities,[]);q.linkEntities[0].joinOperator='LeftOuter';const outer=run(store,q,restricted).entities[0];assert.equal(outer.id,rootId);assert.ok(!Object.hasOwn(outer.attributes,'joined.amount'));
});
test('SDK aggregate counts have Int32 values independently of GUID, money or option source types',()=>{
 const store=data();
 for(const [entity,column,aggregate]of [['root','rootid','count'],['child','amount','countcolumn'],['leaf','flag','countcolumn']]){
  const result=run(store,{$type:'FetchExpression',query:`<fetch aggregate="true"><entity name="${entity}"><attribute name="${column}" alias="records" aggregate="${aggregate}"/></entity></fetch>`});
  assert.equal(result.entities[0].id,'00000000-0000-0000-0000-000000000000');
  assert.deepEqual(result.entities[0].attributes.records,{$type:'AliasedValue',entityLogicalName:entity,attributeLogicalName:column,value:1});
  assert.deepEqual(result.entities[0].formattedValues,{records:'1'});
 }
});
test('SDK grouped lookup names and choice labels come from declared metadata and source rows',()=>{
 const store=data();store.state.mappings.root.nameColumn='title';store.state.mappings.child.fields.rootid={type:'lookup',targets:['root']};store.state.mappings.leaf.fields.flag.options=[{value:2,label:'Ready'}];
 const result=run(store,{$type:'FetchExpression',query:'<fetch aggregate="true"><entity name="child"><attribute name="rootid" alias="group" groupby="true"/><attribute name="childid" alias="records" aggregate="count"/></entity></fetch>'}).entities[0];
 assert.deepEqual(result.attributes.group,{$type:'AliasedValue',entityLogicalName:'child',attributeLogicalName:'rootid',value:{$type:'EntityReference',logicalName:'root',id:rootId,name:'Parent'}});
 assert.deepEqual(result.attributes.group_rootidname,{$type:'AliasedValue',entityLogicalName:'child',attributeLogicalName:'rootidname',value:'Parent'});
 assert.deepEqual(result.formattedValues,{group:'Parent',records:'1'});
 const choices=run(store,{$type:'FetchExpression',query:'<fetch aggregate="true"><entity name="leaf"><attribute name="flag" alias="kind" groupby="true"/><attribute name="leafid" alias="records" aggregate="count"/></entity></fetch>'}).entities[0];assert.deepEqual(choices.formattedValues,{kind:'Ready',records:'1'});
 delete store.state.mappings.root.nameColumn;const withoutName=run(store,{$type:'FetchExpression',query:'<fetch aggregate="true"><entity name="child"><attribute name="rootid" alias="group" groupby="true"/><attribute name="childid" alias="records" aggregate="count"/></entity></fetch>'}).entities[0];assert.equal(withoutName.attributes.group.value.name,null);assert.ok(!Object.hasOwn(withoutName.attributes,'group_rootidname'));
});
test('SDK reference transport retains source-provided identities when the target table is unavailable locally',()=>{
 const result=recordToSdkEntity(data(),'root',{rootid:rootId,creator:{id:user,logical_name:'systemuser'}});
 assert.deepEqual(result.attributes.creator,{$type:'EntityReference',logicalName:'systemuser',id:user,name:null});assert.equal(result.formattedValues,undefined);
});
test('Original linked QueryBase reaches source observers and collection metadata changes survive',()=>{
 const store=data(),seen=[];store.setPluginPipeline(context=>{seen.push(structuredClone(context.query));if(context.stage===40){assert.equal(context.collection.entities[0].attributes['joined.amount'].$type,'AliasedValue');context.collection.moreRecords=true;context.collection.pagingCookie='<cookie page="2"/>';context.collection.totalRecordCount=9;}},({operation})=>operation==='retrievemultiple');const q=query(),answer=run(store,q);assert.deepEqual(seen,[q,q,q]);assert.equal(answer.entities[0].id,rootId);assert.equal(answer.moreRecords,true);assert.equal(answer.totalRecordCount,9);assert.equal(answer.pagingCookie,'<cookie page="2"/>');
});

test('Full-text SDK Contains cannot be silently executed as substring LIKE',()=>{
 const store=data(),q=query();
 for(const operatorName of ['Contains','DoesNotContain']){
  q.linkEntities[0].linkCriteria.conditions=[{attributeName:'amount',operatorName,values:['12']}];
  assert.throws(()=>run(store,q),error=>error.code==='LocalPluginQueryUnsupported'&&error.status===501&&/full-text/.test(error.message));
 }
 q.linkEntities[0].linkCriteria.conditions=[{attributeName:'amount',operatorName:'GreaterThan',values:[10]}];
 q.criteria={conditions:[{attributeName:'title',operatorName:'Like',values:['%aren%']}]};
 assert.equal(run(store,q).entities.length,1);
});


test('FetchExpression observer binding uses the structural root while preserving authored and changed query text',()=>{
 const store=data(),readOnlyBefore=store.pluginReadOnly,seen=[],original='<fetch><!-- source documentation: <entity name="child"/> --><entity\n name = "root"><attribute name="title"/></entity></fetch>';
 store.setPluginPipeline(context=>{seen.push({stage:context.stage,entity:context.entity,query:structuredClone(context.query)});},({operation})=>operation==='retrievemultiple');
 assert.equal(store.fetchXml(original,{admin:true}).entities[0].title,'Parent');assert.deepEqual(seen.map(x=>x.entity),['root','root','root']);assert.deepEqual(seen.map(x=>x.query),[{$type:'FetchExpression',query:original},{$type:'FetchExpression',query:original},{$type:'FetchExpression',query:original}]);
 seen.length=0;const changed='<fetch><entity name="root"><attribute name="title"/><filter><condition attribute="title" operator="eq" value="Parent"/></filter></entity></fetch>';
 store.setPluginPipeline(context=>{if(context.stage===20)context.query.query=changed;seen.push({stage:context.stage,query:structuredClone(context.query)});if(context.stage===40)context.collection.entities[0].attributes.title='Post observer';},({operation})=>operation==='retrievemultiple');
 const result=store.fetchXml(original,{admin:true});assert.equal(result.entities[0].title,'Post observer');assert.deepEqual(seen.map(x=>x.query),[{$type:'FetchExpression',query:original},{$type:'FetchExpression',query:changed},{$type:'FetchExpression',query:changed}]);assert.equal(store.snapshot().tables.root[0].title,'Parent');assert.equal(store.pluginReadOnly,readOnlyBefore);
});

test('FetchExpression structural binding rejects malformed original or changed XML and a changed root table',()=>{
 const store=data(),readOnlyBefore=store.pluginReadOnly,seen=[],valid='<fetch><entity name="root"><attribute name="title"/></entity></fetch>',malformed='<fetch><entity name="root"></fetch>';
 store.setPluginPipeline(context=>seen.push(context.stage),({operation})=>operation==='retrievemultiple');assert.throws(()=>store.fetchXml(malformed,{admin:true}),error=>error.code==='InvalidRequest');assert.deepEqual(seen,[]);
 for(const [source,code]of [[malformed,'InvalidRequest'],['<fetch><entity name="child"/></fetch>','LocalPluginQueryUnsupported']]){seen.length=0;store.setPluginPipeline(context=>{seen.push(context.stage);if(context.stage===20)context.query.query=source;},({operation})=>operation==='retrievemultiple');assert.throws(()=>store.fetchXml(valid,{admin:true}),error=>error.code===code);assert.deepEqual(seen,[10,20]);assert.equal(store.pluginReadOnly,readOnlyBefore);assert.equal(store.snapshot().tables.root[0].title,'Parent');}
});
