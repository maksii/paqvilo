import test from 'node:test';
import assert from 'node:assert/strict';
import {DataStore} from '../lib/data.mjs';
import {observedConfig} from '../lib/project-config.mjs';
import {permissionOrderGraphFingerprint} from '../lib/permission-query.mjs';
import {handleWebApi} from '../lib/webapi-handler.mjs';

const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
function fixture({links=15,second=false}={}) {
  const permissions=[{id:id(1),entity:'grant',scope:'contact',field:'holderid',roles:['member'],operations:['read']},
    {id:id(2),entity:'company',scope:'parent',parentPermissionId:id(1),roles:['member'],operations:['read'],
      relationship:{entity:'grant',from:'companyid',to:'grantid',intersect:{entity:'grantcompany',from:'companyid',to:'grantid'}}}];
  if(second)permissions.push({...permissions[0],id:id(3),field:'reviewerid'}, {...permissions[1],id:id(4),parentPermissionId:id(3)});
  const store=new DataStore({state:{mappings:{company:{entitySet:'companies',idColumn:'companyid'},grant:{entitySet:'grants',idColumn:'grantid'},grantcompany:{entitySet:'grantcompanies',idColumn:'grantcompanyid'}},
    tables:{company:[{companyid:id(10),name:'Own'},{companyid:id(11),name:'Foreign'}],grant:[{grantid:id(20),holderid:id(30)},{grantid:id(21),holderid:id(31)}],
      grantcompany:[{grantcompanyid:id(40),grantid:id(20),companyid:id(10)},{grantcompanyid:id(41),grantid:id(21),companyid:id(11)}]},permissions,settings:{permissionMode:'enforce',platformOverrides:{}}}});
  store.setObserved(observedConfig({tablePermissionQueryPipeline:'native-classic',odataPermissionQueryPipeline:'native-classic',
    odataPermissionGrantOrder:{normalizedGraphHash:permissionOrderGraphFingerprint(store.state.permissions),tables:{company:second?[[id(4)],[id(2)]]:[[id(2)]]}},
    fetchPreOperationSerialization:{company:'compact'},evidence:'Invented native scalar OData execution fixture'}));
  store.querySettings=()=>({fetchLimits:{links}});
  return store;
}
const identity={contactId:id(30),roles:['member']};
test('native scalar OData executes source NN predicates and preserves compact byte order through all stages',()=>{
  const store=fixture(),events=[];store.setPluginPipeline(event=>events.push({stage:event.stage,xml:event.query.query}),()=>true);
  const result=store.query('companies',{$select:'companyid',$orderby:'companyid',$count:'true'},identity,undefined,{portalRequest:true});
  assert.deepEqual(result.value,[{companyid:id(10)}]);assert.equal(result['@odata.count'],1);
  assert.deepEqual(events.map(event=>event.stage),[10,20,40]);assert.ok(events[0].xml.startsWith('<fetch distinct="false" useraworderby="true"'));
  assert.ok(events.every(event=>event.xml===events[0].xml));assert.equal(result.permissionQuery.permissionLinkCount,2);
});
test('native scalar OData expanded execution budgets fail after admitted pre-operation observers',()=>{
  const store=fixture({links:3,second:true}),stages=[];store.setPluginPipeline(event=>stages.push(event.stage),()=>true);
  assert.throws(()=>store.query('companies',{$select:'companyid'},identity,undefined,{portalRequest:true}),error=>error.details?.innerCode==='0x8004430d');
  assert.deepEqual(stages,[10,20]);
});
test('separate native OData profile does not silently qualify unsupported navigation and options',()=>{
  const store=fixture();
  assert.throws(()=>store.query('companies',{$select:'companyid',$expand:'grant'},identity,undefined,{portalRequest:true}),error=>error.code==='ODataPermissionQueryUnsupported');
  assert.throws(()=>observedConfig({odataPermissionQueryPipeline:'native-classic'}),/evidence/);
});
test('native conversion faults happen before observers and retain the CDS status and code at the Web API boundary',async()=>{
  for(const hops of [1,4]){
    const store=fixture(),stages=[];
    let parent=store.state.permissions.find(p=>p.entity==='company');
    for(let n=1;n<=hops;n++){
      const child={id:id(100+n),entity:'level'+n,scope:'parent',parentPermissionId:parent.id,roles:['member'],operations:['read'],
        relationship:{entity:parent.entity,from:'parentid',to:parent.entity+'id'}};
      store.state.permissions.push(child);store.state.mappings[child.entity]={entitySet:child.entity+'s',idColumn:child.entity+'id'};store.state.tables[child.entity]=[];parent=child;
    }
    // A single selected path has no ordering ambiguity. Rebind the source hash
    // after extending the invented graph instead of accepting stale evidence.
    store.setObserved({...store.observed,odataPermissionGrantOrder:{normalizedGraphHash:permissionOrderGraphFingerprint(store.state.permissions),tables:{}}});
    store.setPluginPipeline(event=>stages.push(event.stage),()=>true);
    let status,body;
    const response={headersSent:false,writeHead(code){status=code;this.headersSent=true;},end(value){body=JSON.parse(value);}};
    const url=new URL('http://127.0.0.1/_api/'+parent.entity+'s?$select='+parent.entity+'id');
    await handleWebApi({method:'GET',headers:{}},response,url,{store,identity,
      portal:{settings:{['Webapi/'+parent.entity+'/enabled']:'true',['Webapi/'+parent.entity+'/fields']:parent.entity+'id','Webapi/error/innererror':'true'}},origin:url.origin,origins:[url.origin],csrf:'owned-test-cursor',
      json(res,code,value){res.writeHead(code);res.end(JSON.stringify(value));}});
    assert.equal(status,hops===1?400:501);
    assert.equal(body.error.code,'9004010D');
    assert.equal(body.error.innererror.code,hops===1?'0x80040216':'0x8006088a');
    assert.deepEqual(stages,[]);
  }
});
test('actual Web API collection handler executes the qualified initial OData page rather than falling back to QueryExpression',async()=>{
  const store=fixture(),queries=[];store.setPluginPipeline(event=>queries.push(event.query.$type),()=>true);
  let status,body;
  const response={headersSent:false,writeHead(code){status=code;this.headersSent=true;},end(value){body=JSON.parse(value);}};
  const url=new URL('http://127.0.0.1/_api/companies?$select=companyid&$orderby=companyid&$count=true');
  await handleWebApi({method:'GET',headers:{}},response,url,{store,identity,
    portal:{settings:{'Webapi/company/enabled':'true','Webapi/company/fields':'companyid'}},origin:url.origin,origins:[url.origin],csrf:'owned-test-cursor',
    json(res,code,value){res.writeHead(code);res.end(JSON.stringify(value));}});
  assert.equal(status,200);assert.deepEqual(body.value.map(row=>row.companyid),[id(10)]);assert.equal(body['@odata.count'],1);
  assert.deepEqual(queries,['FetchExpression','FetchExpression','FetchExpression']);
});
