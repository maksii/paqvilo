import test from 'node:test';
import assert from 'node:assert/strict';
import { captureNativeSnapshot, compareNativeSnapshots } from '../portal-harness/native-capture.mjs';
import { batchDispatcher, decodeBatchResponse } from '../portal-harness/batch-capture.mjs';
import { normalize } from '../portal-harness/core.mjs';
import {parseExactJson} from 'paqvilo/mirage/lib/exact-numeric.mjs';

test('native canonical results distinguish Int64 and decimal digits beyond JavaScript precision',()=>{
  const values=parseExactJson('{"one":9007199254740993,"two":9007199254740994,"money":123456789012345.1234}');
  assert.equal(normalize(values.one,{name:'counter',type:'integer'}),'9007199254740993');
  assert.notEqual(normalize(values.one,{name:'counter',type:'integer'}),normalize(values.two,{name:'counter',type:'integer'}));
  assert.equal(normalize(values.money,{name:'amount',type:'money',precision:4}),'123456789012345.1234');
  assert.equal(normalize('9007199254740993',{name:'counter',type:'integer'}),normalize(values.one,{name:'counter',type:'integer'}));
  assert.equal(normalize(3,{name:'choice',type:'choice'}),3);
  assert.throws(()=>normalize('3.5',{name:'counter',type:'integer'}),/Invalid integer/);
});

test('native snapshots read declared identities, memberships and projections; stable logical values ignore OData etags', async () => {
  const requests = [], version = {value: 1};
  const client = {
    async list(query) {
      requests.push(query);
      if (query.startsWith('powerpagecomponents?')) return [{powerpagecomponentid: 'permission', powerpagecomponenttype: 18, content: '{}', '@odata.etag': String(version.value)}, {powerpagecomponentid: 'role', powerpagecomponenttype: 11, statecode: 0}];
      if (query.includes('/powerpagecomponent_mspp_webrole_contact?')) return [{powerpagecomponentid: 'role'}];
      if (query.startsWith('RelationshipDefinitions/')) return [{IntersectEntityName: 'widget_edge', Entity1LogicalName: 'widget', Entity2LogicalName: 'group', Entity1IntersectAttribute: 'widgetid', Entity2IntersectAttribute: 'groupid'}];
      if (query.startsWith('widget_edges?')) return [{widgetid: 'owned', groupid: 'group'}];
      if (query.startsWith('widgets?')) return [{widgetid: 'owned', name: 'same', versionnumber: version.value, '@odata.etag': String(version.value)}];
      throw new Error('Unexpected read');
    },
    async get(query) {requests.push(query); if(query.startsWith('contacts(')) return {contactid:'actor'}; assert.match(query, /EntityDefinitions\(LogicalName='widget_edge'\)/); return {EntitySetName: 'widget_edges'};},
  };
  const input = {siteId: 'site', contactId: 'actor', catalogue: {tables: [{name: 'widget', entitySet: 'widgets', primaryId: 'widgetid'}], records: [{key: 'owned', id: 'owned', table: 'widget'}, {key: 'group', id: 'group', table: 'group'}], associations: [{relationship: 'widget_groups', from: 'owned', to: ['group']}]}};
  const before = await captureNativeSnapshot(client, input); version.value++;
  const after = await captureNativeSnapshot(client, input);
  assert.deepEqual(compareNativeSnapshots(before, after), {stable: false, changed: ['rowVersionSnapshotHash']});
  assert.equal(before.dataSnapshotHash, after.dataSnapshotHash);
  assert.notEqual(before.rowVersionSnapshotHash, after.rowVersionSnapshotHash);
  assert.equal(before.rowVersions.widget.owned, '1');
  assert.equal(before.complete, true);
  assert.ok(requests.every(query => !query.includes('POST') && !query.includes('PATCH')));
  assert.ok(decodeURIComponent(requests.find(query => query.startsWith('widgets?'))).includes('<value>owned</value>'));
  assert.deepEqual(compareNativeSnapshots(before, {...after, membershipSnapshotHash: 'changed'}), {stable: false, changed: ['membershipSnapshotHash', 'rowVersionSnapshotHash']});
  const missing = await captureNativeSnapshot({...client, list: query => query.startsWith('widgets?') ? [] : client.list(query)}, input);
  assert.equal(missing.complete, false); assert.deepEqual(missing.completenessErrors[0].missing, ['owned']);
  assert.ok(compareNativeSnapshots(missing, missing).changed.includes('incomplete-snapshot'));
  const foreign = await captureNativeSnapshot({...client, list: query => query.startsWith('widget_edges?') ? [{widgetid: 'foreign', groupid: 'group'}] : client.list(query)}, input);
  assert.equal(foreign.complete, false); assert.deepEqual(foreign.completenessErrors.find(error => error.kind === 'projection-identities').unexpected, ['foreign:group']);
});

test('native actor Account scope resolves unannotated external customers and rejects ambiguous references',async()=>{
 const calls=[],client={list:async()=>[],get:async()=>({contactid:'actor',_parentcustomerid_value:'external','@odata.etag':'W/"9"'}),optional:async query=>{calls.push(query);return query.startsWith('accounts(')?{accountid:'external',name:'Owned reference','@odata.etag':'W/"12"'}:null;}};
 const input={siteId:'site',contactId:'actor',catalogue:{tables:[],records:[],associations:[]}};
 const before=await captureNativeSnapshot(client,input);
 assert.equal(before.actorBinding.customer.type,'account');assert.equal(before.actorBinding.customer.id,'external');assert.equal(before.rowVersions.actor.contact,'9');assert.equal(before.rowVersions.actor.customer,'12');assert.equal(calls.length,2);
 const changed=await captureNativeSnapshot({...client,optional:async query=>query.startsWith('accounts(')?{accountid:'external',name:'Changed','@odata.etag':'W/"13"'}:null},input);
 assert.notEqual(before.dataSnapshotHash,changed.dataSnapshotHash);assert.notEqual(before.rowVersionSnapshotHash,changed.rowVersionSnapshotHash);
 await assert.rejects(captureNativeSnapshot({...client,optional:async()=>({contactid:'external'})},input),/ambiguous/);
 await assert.rejects(captureNativeSnapshot({...client,optional:async()=>null},input),/absent/);
});

test('bounded batch Liquid preserves owned immutable operation guards and clears each previous result', () => {
  const manifest = {suiteVersion: 'invented', datasetVersion: 'invented', manifestHash: 'invented', cases: [{id: 'C1', table: 'widget', variant: 'fetchxml'}]};
  const source = batchDispatcher(manifest);
  assert.match(source, /batch_operation_ids.size <= 30/);
  assert.match(source, /assign visibility_query = nil/);
  assert.match(source, /entities.pqvd_testoperation\[batch_operation_id\]/);
  assert.match(source, /owned_run.pqvd_runnercontactid.id == user.id/);
  assert.match(source, /operation.pqvd_lane.value == 183270000/);
  assert.match(source, /co-batch-response/);
  assert.throws(() => batchDispatcher(manifest, 31), /bound/);
});

test('batch envelopes bind every unique operation, actor, role set, case and dataset', () => {
  const input = {operations: [{id: 'operation', plan: {id: 'C1'}}], actor: 'actor', roles: ['Reader'], datasetVersion: 'invented'};
  const xml = '<co-batch-response><co-test-response operation-id="operation" case-id="C1" contact-id="actor" dataset-version="invented" outcome="success"><roles><role>Reader</role></roles><records><record><field name="widgetid" null="false">owned</field><field name="optional" null="true"></field></record></records><paging more="false"/><diagnostics><authored-fetchxml>&lt;fetch/&gt;</authored-fetchxml><effective-fetchxml>&lt;fetch distinct="true"/&gt;</effective-fetchxml></diagnostics></co-test-response></co-batch-response>';
  const result = decodeBatchResponse(xml, input);
  assert.deepEqual(result[0].rows, [{widgetid: 'owned', optional: null}]); assert.equal(result[0].more, false);
  assert.equal(result[0].effectiveFetchXml, '<fetch distinct="true"/>');
  assert.equal(decodeBatchResponse(xml.replace('more="false"', 'more="True"'), input)[0].more, true);
  assert.equal(decodeBatchResponse(xml.replace('more="false"', 'more="False"'), input)[0].more, false);
  assert.throws(() => decodeBatchResponse(xml.replace('operation-id="operation"', 'operation-id="other"'), input), /foreign or repeated operation/);
  for (const mutated of [xml.replace('contact-id="actor"', 'contact-id="foreign"'), xml.replace('<role>Reader</role>', '<role>Writer</role>'), xml.replace('case-id="C1"', 'case-id="C2"'), xml.replace('dataset-version="invented"', 'dataset-version="other"')]) assert.throws(() => decodeBatchResponse(mutated, input), /actor, role, case or dataset binding/);
  assert.throws(() => decodeBatchResponse(xml.replace('<co-batch-response>', '<co-batch-response>unhandled error'), input), /loose error text/);
});

test('native DotLiquid boolean strings normalize case-insensitively and malformed values fail', () => {
  const field = {type: 'boolean', name: 'enabled'};
  for (const value of [true, 'true', 'True', 'TRUE', 1, '1']) assert.equal(normalize(value, field), true);
  for (const value of [false, 'false', 'False', 'FALSE', 0, '0']) assert.equal(normalize(value, field), false);
  assert.throws(() => normalize('unknown', field), /Invalid boolean/);
});
