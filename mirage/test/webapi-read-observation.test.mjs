import test from 'node:test';
import assert from 'node:assert/strict';
import {DataStore} from '../lib/data.mjs';
import {DataError} from '../lib/data-error.mjs';
import {handleWebApi,webApiErrorResponse} from '../lib/webapi-handler.mjs';
import {observedConfig} from '../lib/project-config.mjs';
import {dispatchSdkCall} from '../lib/plugin-clr.mjs';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const recordId = '10000000-0000-0000-0000-000000000001';
function fixture() {
  const store = new DataStore({state: {
    mappings: {widget: {entitySet: 'widgets', idColumn: 'widgetid', fields: {title: {type: 'string'}}}},
    tables: {widget: [{widgetid: recordId, title: 'Recorded', versionnumber: 1}]},
    permissions: [{entity: 'widget', scope: 'global', operations: ['read'], roles: ['Reader']}],
    settings: {permissionMode: 'enforce'},
  }});
  return store;
}
async function request(store, path, headers = {}) {
  const events = [], res = {
    headersSent: false,
    writeHead(status, headers) { this.headersSent = true; events.push({status, headers}); },
    end(body) { events.push({body}); },
  };
  const url = new URL(path, 'http://localhost');
  await handleWebApi({method: 'GET', headers}, res, url, {
    store, identity: {contactId: recordId, roles: ['Reader']},
    portal: {settings: {'Webapi/widget/enabled': 'true', 'Webapi/widget/fields': 'title'}},
    origin: url.origin, origins: [url.origin],
    json(out, status, body, headers) { out.writeHead(status, headers); out.end(body); },
  });
  return events;
}

test('read responses wait for the SDK observation persistence boundary, including raw properties and 304', async () => {
  for (const [path, headers, expected] of [
    ['/_api/widgets?$select=title', {}, 200],
    ['/_api/widgets?fetchXml=' + encodeURIComponent('<fetch><entity name="widget"><attribute name="title"/></entity></fetch>'), {}, 200],
    [`/_api/widgets(${recordId})/title/$value`, {}, 200],
    [`/_api/widgets(${recordId})`, {'if-none-match': 'W/"1"'}, 304],
  ]) {
    const store = fixture(); let completed = false;
    store.readOperation = async fn => { await fn(); completed = true; };
    const events = await request(store, path, headers);
    assert.equal(completed, true);
    assert.equal(events[0].status, expected);
    const failure = fixture();
    failure.readOperation = async fn => { await fn(); throw new DataError('Invented persistence conflict', 409, 'StateConflict'); };
    const rejected = await request(failure, path, headers);
    assert.equal(rejected.length, 2, 'No successful response escapes before commit');
    assert.equal(rejected[0].status, 409);
    assert.match(rejected[1].body.error.message, /persistence conflict/);
  }
});

test('API transport marks observer reads explicitly without making direct SDK reads portal calls', async () => {
  const store = fixture(), calls = [];
  const query = store.query.bind(store), fetchXml = store.fetchXml.bind(store), get = store.get.bind(store);
  store.readOperation = async fn => fn();
  store.query = (...args) => { calls.push(args[4]); return query(...args); };
  store.fetchXml = (...args) => { calls.push(args[2]); return fetchXml(...args); };
  store.get = (...args) => { calls.push(args[3]); return get(...args); };
  await request(store, '/_api/widgets?$select=title');
  await request(store, '/_api/widgets?fetchXml=' + encodeURIComponent('<fetch><entity name="widget"><attribute name="title"/></entity></fetch>'));
  await request(store, `/_api/widgets(${recordId})/title`);
  assert.ok(calls.length >= 4);
  assert.ok(calls.every(options => options.portalRequest === true));
});

test('permission-generated Dataverse query limits retain a CDS execution error envelope', async () => {
  for (const innerCode of ['0x8004430c', '0x8004430d']) {
    const store = fixture();
    store.query = () => { throw new DataError('Invented Dataverse query budget exceeded', 400, 'UnsupportedQuery', {innerCode}); };
    const events = await request(store, '/_api/widgets?$select=title');
    assert.equal(events[0].status, 400);
    assert.equal(events[1].body.error.code, '9004010D');
  }
});

test('evidenced CDS code shape preserves the platform code without enabling inner error details',()=>{
  const failure=new DataError('Bounded query budget exceeded',400,'UnsupportedQuery',{innerCode:'0x8004430d'});
  const response=webApiErrorResponse(failure,{cdsErrorCode:'cdscode',cdsErrorMessage:'Common Data Service error occurred.'});
  assert.deepEqual(response.body,{error:{code:'9004010D',message:'Common Data Service error occurred.',cdscode:'0x8004430d'}});
  assert.equal(response.status,400);
  assert.equal(webApiErrorResponse(failure).body.error.cdscode,undefined);
  assert.throws(()=>observedConfig({webApiCdsErrorCode:'cdscode'}),/evidence/);
});

test('native API authored-budget admission keeps its separate unexpected-error envelope',()=>{
  const failure=new DataError('Rejected authored query',500,'PortalQueryAdmissionFailure',{phase:'native-api-admission'});
  assert.deepEqual(webApiErrorResponse(failure).body,{error:{code:'9004010A',message:'An unexpected error occurred while processing the request'}});
  assert.equal(webApiErrorResponse(failure).status,500);
});

test('actual Web API policy preflight applies native authored-budget admission before table denial',async()=>{
  const store=fixture();store.state.permissions=[];
  store.setObserved({tablePermissionQueryPipeline:'native-classic',evidence:'Invented authored-budget admission'});
  const links=Array.from({length:16},(_,index)=>`<link-entity name="widget" from="widgetid" to="widgetid" alias="w${index}"/>`).join('');
  const source=`<fetch><entity name="widget"><attribute name="widgetid"/>${links}</entity></fetch>`;
  const response=await request(store,'/_api/widgets?fetchXml='+encodeURIComponent(source));
  assert.equal(response[0].status,500);
  assert.deepEqual(response[1].body,{error:{code:'9004010A',message:'An unexpected error occurred while processing the request'}});
});

test('an evidenced global metadata version is preserved as an opaque string in the API response',async()=>{
  const store=fixture();store.setObserved(observedConfig({webApiGlobalMetadataVersion:'9007199254740993',evidence:'Invented frozen organization metadata witness'}));
  const source='<fetch><entity name="widget"><attribute name="widgetid"/></entity></fetch>';
  const response=await request(store,'/_api/widgets?fetchXml='+encodeURIComponent(source));
  assert.equal(response[0].status,200);
  assert.equal(response[1].body['@Microsoft.Dynamics.CRM.globalmetadataversion'],'9007199254740993');
  assert.throws(()=>observedConfig({webApiGlobalMetadataVersion:'1'}),/evidence/);
  assert.throws(()=>observedConfig({webApiGlobalMetadataVersion:1,evidence:'Source'}),/numeric string/);
});

test('native API permits structural join keys while retaining their projection, filter and order policies',async()=>{
  const store=fixture();
  store.state.mappings.detail={entitySet:'details',idColumn:'detailid',fields:{widgetid:{type:'guid'},detailid:{type:'guid'}}};
  store.state.tables.detail=[{detailid:'30000000-0000-0000-0000-000000000003',widgetid:recordId}];
  store.state.permissions.push({entity:'detail',scope:'global',operations:['read'],roles:['Reader']});
  store.setObserved({tablePermissionQueryPipeline:'native-classic',evidence:'Invented structural key and metadata wire fixtures'});
  const portal={settings:{'Webapi/widget/enabled':'true','Webapi/widget/fields':'title','Webapi/detail/enabled':'true','Webapi/detail/fields':'detailid'}};
  const run=async(xml)=>{
    let status,body;
    await handleWebApi({method:'GET',headers:{}},{headersSent:false},new URL('/_api/widgets?fetchXml='+encodeURIComponent(xml),'http://localhost'),
      {store,portal,identity:{contactId:recordId,roles:['Reader']},origin:'http://localhost',origins:['http://localhost'],json(_res,s,b){status=s;body=b;}});
    return {status,body};
  };
  const xml=content=>`<fetch returntotalrecordcount="true"><entity name="widget"><attribute name="widgetid"/><link-entity name="detail" from="widgetid" to="widgetid" alias="joined">${content}</link-entity></entity></fetch>`;
  const result=await run(xml('<attribute name="detailid"/>'));
  assert.equal(result.status,200);assert.equal(result.body.value.length,1);
  assert.equal(result.body['@odata.count'],1);
  assert.equal(result.body['@joined.OData.Community.Display.V1.CurrentEntityField'],'widgetid');
  for(const content of ['<attribute name="widgetid"/>','<filter><condition attribute="widgetid" operator="not-null"/></filter>','<order attribute="widgetid"/>']){
    const denied=await run(xml(content));assert.equal(denied.status,403);assert.equal(denied.body.error.code,'90040101');
  }
  store.state.permissions=store.state.permissions.filter(rule=>rule.entity!=='detail');
  const denied=await run(xml('<attribute name="widgetid"/>'));
  assert.equal(denied.status,403);assert.equal(denied.body.error.code,'90040120');
});

test('native aggregate context omits an empty select suffix and reports its group count',async()=>{
  const store=fixture();store.setObserved({tablePermissionQueryPipeline:'native-classic',evidence:'Invented aggregate wire fixture'});
  const source='<fetch aggregate="true" returntotalrecordcount="true"><entity name="widget"><attribute name="widgetid" alias="total" aggregate="count"/></entity></fetch>';
  const response=await request(store,'/_api/widgets?fetchXml='+encodeURIComponent(source));
  assert.equal(response[0].status,200);
  assert.equal(response[1].body['@odata.context'],'http://localhost/_api/$metadata#widgets');
  assert.equal(response[1].body['@odata.count'],1);
});

test('native empty FetchXML responses retain counts while omitting the selected-column context suffix',async()=>{
  const store=fixture();store.setObserved({tablePermissionQueryPipeline:'native-classic',evidence:'Invented empty wire fixture'});
  const source='<fetch returntotalrecordcount="true"><entity name="widget"><attribute name="widgetid"/><filter><condition attribute="title" operator="eq" value="Missing"/></filter></entity></fetch>';
  const response=await request(store,'/_api/widgets?fetchXml='+encodeURIComponent(source));
  assert.equal(response[0].status,200);
  assert.deepEqual(response[1].body.value,[]);
  assert.equal(response[1].body['@odata.context'],'http://localhost/_api/$metadata#widgets');
  assert.equal(response[1].body['@odata.count'],0);
});

test('HTTP read observer records through its own SDK grants, including a later failed read', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'paqvilo-read-observation-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  for (const failAfterRead of [false, true]) {
    const store = fixture();
    store.state.mappings.observation = {entitySet: 'observations', idColumn: 'observationid'};
    store.state.tables.observation = [];
    store.file = path.join(directory, `${failAfterRead}.json`);
    await store.init();
    const phases = [];
    const userId = '20000000-0000-0000-0000-000000000001';
    store.setPluginPipeline(context => {
      phases.push({stage: context.stage, portalRequest: context.portalRequest});
      if (context.stage === 20) dispatchSdkCall({store,
        profile: {userId, evidence: 'Invented read observation backend', grants: [{entity: 'observation', operations: ['create']}]},
        message: {method: 'Create', userId, arguments: [{$type: 'Entity', logicalName: 'observation', attributes: {title: 'Incoming query recorded'}}]},
      });
      if (context.stage === 40 && failAfterRead) throw new DataError('Invented late read rejection', 400, 'PluginValidation');
    }, ({entity, operation}) => entity === 'widget' && operation === 'retrievemultiple');
    const events = await request(store, '/_api/widgets?$select=title');
    assert.equal(events[0].status, failAfterRead ? 400 : 200);
    assert.deepEqual(phases, [10, 20, 40].map(stage => ({stage, portalRequest: true})));
    assert.equal(store.tableRows('observation').length, 1);
    assert.equal(store.tableRows('observation')[0].title, 'Incoming query recorded');
    assert.equal(JSON.parse(await readFile(store.file, 'utf8')).tables.observation.length, 1);
    assert.deepEqual(store.rows('observation', {contactId: recordId, roles: ['Reader']}), []);
  }
});
