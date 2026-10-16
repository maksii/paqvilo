import test from 'node:test';
import assert from 'node:assert/strict';
import {DataStore} from '../lib/data.mjs';
import {compilePermissionFetchXml,permissionOrderGraphFingerprint} from '../lib/permission-query.mjs';
import {parseXmlDocument} from '../lib/fetchxml-engine.mjs';

function fixture() {
  const principals=[{principalid:'p0',red:'person',blue:'other'},{principalid:'p1',red:'other',blue:'person'},
    {principalid:'p2',red:'person',blue:'person'},{principalid:'p3',red:'other',blue:'other'}];
  const memberships=[['p0','p1','p2','p3'],['p0'],['p1'],[],['p3']];
  const permissions=['red','blue'].flatMap(role=>[
    {id:role,entity:'principal',scope:'contact',field:role,roles:[role],operations:['read']},
    {id:'folder-'+role,entity:'folder',scope:'parent',roles:[role],operations:['read'],parentPermissionId:role,
      relationship:{entity:'principal',from:'folderid',to:'principalid',intersect:{entity:'membership',from:'folderid',to:'principalid'}}},
    {id:'item-'+role,entity:'item',scope:'parent',roles:[role],operations:['read',role==='red'?'update':'delete'],parentPermissionId:'folder-'+role,
      relationship:{entity:'folder',from:'folderid',to:'folderid'}},
  ]);
  permissions.push({id:'details',entity:'detail',scope:'global',roles:['red','blue'],operations:['read']});
  const tables={principal:principals,folder:memberships.map((_,i)=>({folderid:'f'+i})),
    item:memberships.map((_,i)=>({itemid:'i'+i,folderid:'f'+i})),
    detail:memberships.flatMap((_,i)=>[0,1].map(j=>({detailid:`d${i}${j}`,itemid:'i'+i}))),
    membership:memberships.flatMap((ids,i)=>ids.map(principalid=>({membershipid:'f'+i+principalid,folderid:'f'+i,principalid}))) };
  const store=new DataStore({state:{mappings:Object.fromEntries(Object.keys(tables).map(entity=>[entity,{idColumn:entity+'id',entitySet:entity+'s'}])),
    tables,permissions,settings:{permissionMode:'enforce'}}});
  store.setObserved({tablePermissionQueryPipeline:'native-classic',evidence:'Invented overlapping N:N permission paths and authored join cardinality controls'});
  return {store,memberships,principals};
}
const api={portalRequest:true,profile:'webapi'};
const xml=(distinct,link='',aggregate=false)=>`<fetch ${distinct==null?'':`distinct="${distinct}"`} ${aggregate?'aggregate="true"':''}><entity name="item"><attribute name="itemid" ${aggregate?'aggregate="count" alias="total"':''}/>${link}</entity></fetch>`;

test('scoped native API unions every overlapping role subset without multiplying projected roots or authored tuples',()=>{
  const {store,memberships,principals}=fixture();
  for(const roles of [['red'],['blue'],['red','blue']]){
    const identity={contactId:'person',roles};
    const expected=memberships.flatMap((ids,i)=>ids.some(id=>roles.some(role=>principals.find(p=>p.principalid===id)[role]==='person'))?['i'+i]:[]);
    for(const distinct of [null,'false','0','true']){
      const result=store.fetchXml(xml(distinct),identity,api);
      assert.deepEqual(result.entities.map(row=>row.itemid),expected,roles+' '+distinct);
      assert.match(result.xml,/distinct="true"/);
      assert.ok(!result.permissionQuery.diagnostics.some(d=>d.code==='PERMISSION_QUERY_ROW_MULTIPLICATION'));
      const linked=store.fetchXml(xml(distinct,'<link-entity name="detail" from="itemid" to="itemid" alias="d"><attribute name="detailid"/></link-entity>'),identity,api);
      assert.equal(linked.entities.length,expected.length*2,'DISTINCT includes authored linked projections');
      const unprojected=store.fetchXml(xml(distinct,'<link-entity name="detail" from="itemid" to="itemid" alias="d"/>'),identity,api);
      assert.equal(unprojected.entities.length,expected.length,'scoped DISTINCT includes only projected tuples');
    }
    assert.deepEqual(store.tableRows('item').filter(row=>store.allowed('item','update',row,identity)).map(row=>row.itemid),roles.includes('red')?['i0','i1']:[]);
    assert.deepEqual(store.tableRows('item').filter(row=>store.allowed('item','delete',row,identity)).map(row=>row.itemid),roles.includes('blue')?['i0','i2']:[]);
  }
  assert.throws(()=>store.fetchXml(xml('false'),{contactId:'person',roles:[]},api),error=>error.code==='PermissionDenied');
});

test('scoped DISTINCT leaves aggregate input multiplicity intact instead of replacing permissions with existential filters',()=>{
  const {store}=fixture(),identity={contactId:'person',roles:['red','blue']};
  // Four edges on f0 give 4*4 combinations minus 2*2 unqualified pairs;
  // f1 and f2 each contribute one pair. Three visible roots aggregate to 14.
  for(const distinct of [null,'false','true'])
    assert.deepEqual(store.fetchXml(xml(distinct,'',true),identity,api).entities,[{total:14}]);
});

test('native Liquid preserves omitted and explicit count requests independently of page size and DISTINCT',()=>{
  const {store}=fixture(),identity={contactId:'person',roles:['red','blue']};
  for(const [flag,total] of [['',-1],[' returntotalrecordcount="false"',-1],[' returntotalrecordcount="true"',3]]){
    const source='<fetch count="2" page="1"'+flag+'><entity name="item"><attribute name="itemid"/><order attribute="itemid"/></entity></fetch>';
    const result=store.fetchXml(source,identity,{portalRequest:true});
    assert.deepEqual(result.entities,[{itemid:'i0'},{itemid:'i1'}]);
    assert.equal(result.more_records,true);assert.equal(result.total_record_count,total);
    assert.equal(result.permissionQuery.permissionLinkCount,6);
    assert.equal(parseXmlDocument(result.xml).attrs.returntotalrecordcount,flag?String(total===3):undefined);
  }
});

test('native scoped Liquid also overrides explicit DISTINCT without changing permission joins or aggregates',()=>{
  const {store}=fixture(),identity={contactId:'person',roles:['red','blue']};
  for(const distinct of [null,'false','0','true']){
    const result=store.fetchXml(xml(distinct),identity,{portalRequest:true});
    assert.deepEqual(result.entities.map(row=>row.itemid),['i0','i1','i2']);
    assert.equal(result.permissionQuery.permissionLinkCount,6);
    assert.match(result.xml,/distinct="true"/);
    assert.deepEqual(store.fetchXml(xml(distinct,'',true),identity,{portalRequest:true}).entities,[{total:14}]);
  }
});

test('native generated aliases reserve authored occurrences of the same linked table',()=>{
  const {store}=fixture(),identity={contactId:'person',roles:['red']};
  for(const count of [1,2]){
    const authored=Array.from({length:count},(_,i)=>`<link-entity name="folder" from="folderid" to="folderid" alias="authored${i}"/>`).join('');
    const result=store.fetchXml(xml('false',authored),identity,{portalRequest:true});
    assert.match(result.xml,new RegExp(`alias="generated_alias_folder_${count}"`));
    assert.equal(result.permissionQuery.authoredLinkCount,count);
    assert.equal(result.permissionQuery.permissionLinkCount,3);
    assert.equal(result.permissionQuery.totalLinkCount,count+3);
    assert.deepEqual(result.entities.map(row=>row.itemid),['i0','i1']);
  }
});

test('a Global union and backend reads retain authored DISTINCT instead of adopting scoped portal semantics',()=>{
  const {store}=fixture(),identity={contactId:'person',roles:['red','blue']};
  store.state.permissions.push({id:'global',entity:'item',scope:'global',roles:['red'],operations:['read']});
  const source=xml('false','<link-entity name="detail" from="itemid" to="itemid"/>');
  assert.equal(store.fetchXml(source,identity,api).entities.length,10);
  assert.equal(store.fetchXml(source,{admin:true}).entities.length,10);
});

test('scoped DISTINCT preserves every permission link and rejects the expanded sixteenth link before retrieval',()=>{
  const {store}=fixture(),identity={contactId:'person',roles:['red','blue']};
  const authored=count=>Array.from({length:count},(_,index)=>
    `<link-entity name="detail" from="itemid" to="itemid" alias="detail${index}"/>`).join('');
  const source=xml('false',authored(9));
  const options={permissions:store.state.permissions,mappings:store.state.mappings,identity};
  const original=compilePermissionFetchXml(source,options);
  const secured=compilePermissionFetchXml(source,{...options,defaultDistinct:false,forceScopedDistinct:true});
  const before=parseXmlDocument(original.xml,{root:'fetch'}),after=parseXmlDocument(secured.xml,{root:'fetch'});
  delete before.attrs.distinct;delete after.attrs.distinct;
  assert.deepEqual(after,before,'DISTINCT changes no authored/generated join or permission condition');
  assert.equal(secured.permissionLinkCount,6);
  assert.equal(secured.authoredLinkCount,9);
  assert.equal(secured.totalLinkCount,15);
  const admitted=store.fetchXml(source,identity,api);
  assert.equal(admitted.permissionQuery.totalLinkCount,15);
  assert.deepEqual(admitted.entities.map(row=>row.itemid),['i0','i1','i2']);
  const diagnostics=[];
  assert.throws(()=>store.fetchXml(xml('false',authored(10)),identity,{...api,diagnostic:d=>diagnostics.push(d)}),error=>
    error.details?.innerCode==='0x8004430d'&&error.details.permissionDiagnostic?.totalLinks===16);
  assert.equal(diagnostics.at(-1).code,'PERMISSION_LINK_BUDGET_EXCEEDED');
  assert.equal(diagnostics.at(-1).generatedLinks,6);
  assert.equal(diagnostics.at(-1).authoredLinks,10);
});

test('observed source order also governs complete permission alternatives inside authored linked tables',()=>{
  const {store}=fixture(),identity={contactId:'person',roles:['red','blue']};
  store.state.permissions.push({id:'global',entity:'item',scope:'global',roles:['red'],operations:['read']});
  const source=xml('true','<link-entity name="folder" from="folderid" to="folderid" alias="authored"/>');
  const options={permissions:store.state.permissions,mappings:store.state.mappings,identity,linkedPermissionOrdinals:[0]};
  const grantOrder={normalizedGraphHash:permissionOrderGraphFingerprint(store.state.permissions),tables:{
    item:[['global'],['item-red'],['item-blue']],folder:[['folder-blue'],['folder-red']],
  }};
  const walk=function*(node){yield node;for(const child of node.children)yield*walk(child);};
  const principals=query=>[...walk(parseXmlDocument(query.xml,{root:'fetch'}))]
    .filter(node=>node.name==='link-entity'&&node.attrs.name==='contact').map(node=>node.attrs.to);
  const unordered=compilePermissionFetchXml(source,options),ordered=compilePermissionFetchXml(source,{...options,grantOrder});
  assert.deepEqual(principals(unordered),['red','blue']);
  assert.deepEqual(principals(ordered),['blue','red']);
  assert.equal(ordered.permissionLinkCount,6,'Both complete intersect/principal paths remain present');
  assert.equal(ordered.totalLinkCount,7);
  assert.equal(ordered.totalLinkCount,unordered.totalLinkCount);
  assert.throws(()=>compilePermissionFetchXml(source,{...options,grantOrder:{...grantOrder,tables:{...grantOrder.tables,folder:[['folder-blue']]}}}),
    error=>error.code==='PermissionGrantOrderUnqualified');
});
