import test from 'node:test';
import assert from 'node:assert/strict';
import {DataStore} from '../lib/data.mjs';
import {parseXmlDocument} from '../lib/fetchxml-engine.mjs';
import {observedConfig} from '../lib/project-config.mjs';

const observed={tablePermissionQueryPipeline:'native-classic',evidence:'Invented lane admission and joined-column fixtures'};
const visitor={contactId:'person',roles:['Reader']};
function fixture(permissions=[]){
  const store=new DataStore({state:{mappings:{widget:{entitySet:'widgets',idColumn:'widgetid'},detail:{entitySet:'details',idColumn:'detailid'}},
    tables:{widget:[{widgetid:'one',owner:'person'},{widgetid:'two',owner:'other'}],detail:[{detailid:'detail',widgetid:'one',amount:12}]},permissions,settings:{permissionMode:'enforce'}}});
  store.setObserved(observed);return store;
}
const own={id:'own',entity:'widget',scope:'contact',field:'owner',roles:['Reader'],operations:['read']};

test('denied native Liquid reads expose normalized authored XML without calling plugins or synthesizing aggregates',()=>{
  const store=fixture(),stages=[];store.setPluginPipeline(event=>stages.push(event.stage),()=>true);
  for(const source of ['<fetch><entity name="widget"><attribute name="widgetid"/></entity></fetch>',
    '<fetch aggregate="true"><entity name="widget"><attribute name="widgetid" aggregate="count" alias="total"/></entity></fetch>']){
    const result=store.fetchXml(source,visitor,{portalRequest:true});
    assert.deepEqual(result.entities,[]);assert.equal(result.total_record_count,0);assert.equal(result.backendAdmission,'denied-before-dataverse');
    assert.equal(parseXmlDocument(result.xml,{root:'fetch'}).attrs.distinct,undefined);
  }
  assert.deepEqual(stages,[]);
});

test('native Liquid joined data uses the compiled root query while Web API denies unreadable authored tables',()=>{
  const store=fixture([own]),source='<fetch><entity name="widget"><attribute name="widgetid"/><link-entity name="detail" from="widgetid" to="widgetid" alias="d"><attribute name="amount"/></link-entity></entity></fetch>';
  assert.deepEqual(store.fetchXml(source,visitor,{portalRequest:true}).entities,[{widgetid:'one','d.amount':12}]);
  assert.throws(()=>store.fetchXml(source,visitor,{portalRequest:true,profile:'webapi'}),error=>error.code==='PermissionDenied'&&error.details.table==='detail');
  store.setObserved(null);assert.deepEqual(store.fetchXml(source,visitor,{portalRequest:true}).entities,[],'Default row filtering remains closed');
});

test('native API expanded join budgets reject before plugins, while Liquid records its admitted PreOperation phases',()=>{
  const store=fixture([
    {id:'principal',entity:'detail',scope:'contact',field:'owner',roles:['Reader'],operations:['read']},
    {id:'parent-path',entity:'widget',scope:'parent',parentPermissionId:'principal',roles:['Reader'],operations:['read'],relationship:{entity:'detail',from:'widgetid',to:'widgetid'}},
  ]),stages=[];store.setPluginPipeline(event=>stages.push(event.stage),()=>true);
  const links=Array.from({length:15},(_,index)=>`<link-entity name="widget" from="widgetid" to="widgetid" alias="w${index}"/>`).join('');
  const source=`<fetch><entity name="widget"><attribute name="widgetid"/>${links}</entity></fetch>`;
  assert.throws(()=>store.fetchXml(source,visitor,{portalRequest:true,profile:'webapi'}),error=>error.details.innerCode==='0x8004430d');
  assert.deepEqual(stages,[]);
  assert.throws(()=>store.fetchXml(source,visitor,{portalRequest:true}),error=>error.details.innerCode==='0x8004430d');
  assert.deepEqual(stages,[10,20]);
});

test('native authored join overflow rejects API before root grants while denied Liquid skips backend budgets',()=>{
  const store=fixture(),stages=[];store.setPluginPipeline(event=>stages.push(event.stage),()=>true);
  const links=Array.from({length:16},(_,index)=>`<link-entity name="widget" from="widgetid" to="widgetid" alias="w${index}"/>`).join('');
  const source=`<fetch><entity name="widget"><attribute name="widgetid"/>${links}</entity></fetch>`;
  assert.throws(()=>store.fetchXml(source,visitor,{portalRequest:true,profile:'webapi'}),error=>error.status===500&&error.code==='PortalQueryAdmissionFailure');
  assert.deepEqual(store.fetchXml(source,visitor,{portalRequest:true}).entities,[]);
  assert.deepEqual(stages,[]);
});

test('native lane observations require a named source witness',()=>{
  assert.throws(()=>observedConfig({tablePermissionQueryPipeline:'native-classic'}),/evidence/);
  assert.equal(observedConfig(observed).tablePermissionQueryPipeline,'native-classic');
});

test('evidenced table-specific serialization changes backend input after PreValidation while Liquid retains its XML',()=>{
  const store=fixture([own]),queries=[];
  store.setObserved(observedConfig({...observed,fetchPreOperationSerialization:{widget:'compact'}}));
  store.setPluginPipeline(event=>queries.push({stage:event.stage,xml:event.query.query}),()=>true);
  const result=store.fetchXml('<fetch><entity name="widget"><attribute name="widgetid"/></entity></fetch>',visitor,{portalRequest:true});
  assert.ok(queries[0].xml.includes('\r\n'));
  assert.ok(!queries[1].xml.includes('\r\n'));
  assert.equal(queries[1].xml,queries[2].xml);
  assert.equal(result.xml,queries[0].xml);
  assert.equal(result.executedXml,queries[1].xml);
  assert.deepEqual(result.entities,[{widgetid:'one'}]);
  assert.throws(()=>observedConfig({fetchPreOperationSerialization:{widget:'compact'}}),/evidence/);
  assert.throws(()=>observedConfig({...observed,fetchPreOperationSerialization:{widget:'invented'}}),/must map/);
});

test('native distinct projections without primary keys and linked sorting retain their observed cookie forms',()=>{
  const store=fixture([own]);
  const projection=store.fetchXml('<fetch><entity name="widget"><attribute name="owner"/><order attribute="owner"/></entity></fetch>',visitor,{portalRequest:true});
  assert.equal(projection.paging_cookie,null);
  const source='<fetch><entity name="widget"><attribute name="widgetid"/><link-entity name="detail" from="widgetid" to="widgetid" alias="d"><attribute name="amount"/><order attribute="amount"/></link-entity></entity></fetch>';
  const linked=store.fetchXml(source,visitor,{portalRequest:true});
  assert.equal(linked.paging_cookie,'');
  const emptyLinked=store.fetchXml(source.replace('<attribute name="widgetid"/>','<attribute name="widgetid"/><filter><condition attribute="widgetid" operator="eq" value="absent"/></filter>'),visitor,{portalRequest:true});
  assert.equal(emptyLinked.paging_cookie,'','Linked-order cookie support is a query property, including empty results');
  const empty=store.fetchXml('<fetch><entity name="widget"><attribute name="widgetid"/><filter><condition attribute="widgetid" operator="eq" value="absent"/></filter></entity></fetch>',visitor,{portalRequest:true});
  assert.equal(empty.paging_cookie,'','A supported empty page derives its native cookie without a recorded result override');
  const emptyDistinct=store.fetchXml('<fetch><entity name="widget"><attribute name="owner"/><filter><condition attribute="widgetid" operator="eq" value="absent"/></filter></entity></fetch>',visitor,{portalRequest:true});
  assert.equal(emptyDistinct.paging_cookie,null,'Unsupported distinct paging stays null when there are no rows');
});

test('native Liquid executes the backend predicate after a trusted observer changes the compiled query',()=>{
  const store=fixture([own]);
  store.setPluginPipeline(event=>{
    if(event.stage===20)event.query.query=event.query.query.replace('attribute="owner" operator="eq" value="person"','attribute="owner" operator="not-null"');
  },()=>true);
  const result=store.fetchXml('<fetch><entity name="widget"><attribute name="widgetid"/></entity></fetch>',visitor,{portalRequest:true});
  assert.deepEqual(result.entities,[{widgetid:'one'},{widgetid:'two'}]);
  assert.ok(result.xml.includes('value="person"'),'Exposed Liquid XML retains its initial permission condition');
  assert.ok(result.executedXml.includes('operator="not-null"'),'Backend execution and observers use the changed query');
});

test('native API expands authored joined tables into source-derived existential principal paths',()=>{
  const store=new DataStore({state:{settings:{permissionMode:'enforce'},mappings:{
    widget:{entitySet:'widgets',idColumn:'widgetid'},detail:{entitySet:'details',idColumn:'detailid'},
    project:{entitySet:'projects',idColumn:'projectid'},contact:{entitySet:'contacts',idColumn:'contactid'},
  },tables:{widget:[{widgetid:'one',owner:'person'}],
    detail:[{detailid:'visible',widgetid:'one',projectid:'mine'},{detailid:'private',widgetid:'one',projectid:'theirs'}],
    project:[{projectid:'mine',owner:'person'},{projectid:'theirs',owner:'other'}],
    contact:[{contactid:'person'},{contactid:'other'}]},permissions:[own,
    {id:'project-reader',entity:'project',scope:'contact',field:'owner',roles:['Reader'],operations:['read']},
    {id:'detail-reader',entity:'detail',scope:'parent',parentPermissionId:'project-reader',roles:['Reader'],operations:['read'],relationship:{entity:'project',from:'projectid',to:'projectid'}},
  ]}});
  store.setObserved(observed);
  const source='<fetch><entity name="widget"><attribute name="widgetid"/><link-entity name="detail" from="widgetid" to="widgetid" alias="d"><attribute name="detailid"/></link-entity></entity></fetch>';
  const result=store.fetchXml(source,visitor,{portalRequest:true,profile:'webapi'});
  assert.deepEqual(result.entities,[{widgetid:'one','d.detailid':'visible'}]);
  const tree=parseXmlDocument(result.xml,{root:'fetch'}),root=tree.children.find(node=>node.name==='entity');
  const authored=root.children.find(node=>node.name==='link-entity');
  const permission=authored.children.find(node=>node.name==='filter').children[0].children[0];
  assert.deepEqual({...permission.attrs},{name:'project',from:'projectid',to:'projectid','link-type':'any'});
  assert.deepEqual({...permission.children[0].attrs},{name:'contact',from:'contactid',to:'owner','link-type':'inner'});
  assert.deepEqual({...permission.children[0].children[0].children[0].attrs},{attribute:'contactid',operator:'eq',value:'person'});
  assert.equal(result.permissionQuery.authoredLinkCount,1);
  assert.equal(result.permissionQuery.permissionLinkCount,2);
  assert.deepEqual(store.fetchXml(source,visitor,{portalRequest:true}).entities,
    [{widgetid:'one','d.detailid':'private'},{widgetid:'one','d.detailid':'visible'}]);
});

test('an authored intersect flag alone cannot bypass the native API table admission check',()=>{
  const store=fixture([own]);
  const source='<fetch><entity name="widget"><attribute name="widgetid"/><link-entity name="detail" from="widgetid" to="widgetid" intersect="true"/></entity></fetch>';
  assert.throws(()=>store.fetchXml(source,visitor,{portalRequest:true,profile:'webapi'}),error=>error.code==='PermissionDenied'&&error.details.table==='detail');
});
