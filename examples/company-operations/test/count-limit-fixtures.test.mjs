import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {planCountLimitFixtures,bindCountLimitFixtureRequests} from '../portal-security/count-limit-fixtures.mjs';

const schema=JSON.parse(await fs.readFile(new URL('../dataverse/manifest.json',import.meta.url),'utf8'));
const catalogue=JSON.parse(await fs.readFile(new URL('../data/stress-catalogue.json',import.meta.url),'utf8'));
const actor='10000000-0000-0000-0000-000000000001',run='20000000-0000-0000-0000-000000000001',ownedRun='30000000-0000-0000-0000-000000000001';
const options=()=>({schema,catalogue,actorContactId:actor,runId:run,ownedRunId:ownedRun,resolvedIds:Object.fromEntries(catalogue.records.map(row=>[row.key,row.id]))});

test('count-limit plan has 5010 isolated uniquely keyed Stock fixtures and a five-row metadata probe',()=>{
 const plan=planCountLimitFixtures(options());assert.equal(plan.records.length,5010);assert.equal(new Set(plan.records.map(row=>row.id)).size,5010);assert.equal(new Set(plan.records.map(row=>row.fields.pqvd_assettag)).size,5010);
 assert.ok(plan.records.every(row=>row.fields.pqvd_equipmentstate===183270000&&row.refs.pqvd_currentassignmentid===null&&row.refs.pqvd_canaryrunid.id===ownedRun));
 assert.equal(plan.query.pageSize,5);assert.equal(plan.configuration.expectedTotalRecordCount,5000);assert.equal(plan.nativeDataVerified,false);assert.equal(plan.nativeExecution,false);
 assert.notEqual(planCountLimitFixtures({...options(),runId:ownedRun}).records[0].id,plan.records[0].id);
 assert.throws(()=>planCountLimitFixtures({...options(),size:5000}),/between/);assert.throws(()=>planCountLimitFixtures({...options(),size:999999}),/between/);
});

test('count-limit metadata binder verifies owning hierarchy and Run actor before returning resumable writes',async()=>{
 const plan=planCountLimitFixtures(options()),byKey=new Map(catalogue.records.map(row=>[row.key,row]));
 const room=byKey.get('CANARY-A-pqvd_room'),building=byKey.get(room.refs.pqvd_buildingid),site=byKey.get(building.refs.pqvd_siteid),account=byKey.get(site.refs.pqvd_accountid);
 let foreign=false,reads=0;
 const client={url:path=>'https://example.invalid/'+path,async get(path){reads++;if(path.startsWith('pqvd_testruns('))return {_pqvd_runnercontactid_value:actor};if(path.startsWith('pqvd_rooms('))return {_pqvd_buildingid_value:building.id};if(path.startsWith('pqvd_buildings('))return {_pqvd_siteid_value:site.id};if(path.startsWith('pqvd_sites('))return {_pqvd_accountid_value:foreign?actor:account.id};throw new Error('Unexpected read');},async list(){return [['pqvd_accountid','account'],['pqvd_roomid','pqvd_room'],['pqvd_currentassignmentid','pqvd_assignment'],['pqvd_canaryrunid','pqvd_testrun']].map(([ReferencingAttribute,ReferencedEntity])=>({ReferencingAttribute,ReferencedEntity,ReferencingEntityNavigationPropertyName:ReferencingAttribute}));},async request(){throw new Error('Planner must not execute native writes');}};
 const bound=await bindCountLimitFixtureRequests(client,plan);assert.equal(bound.requests.length,5010);assert.equal(bound.owningHierarchyVerified,true);assert.equal(bound.ownedRunActorVerified,true);assert.equal(reads,4);assert.ok(bound.requests.every(request=>request.ifNoneMatch==='*'));
 foreign=true;await assert.rejects(()=>bindCountLimitFixtureRequests(client,plan),/does not belong/);
 const changed=structuredClone(plan);changed.records[0].id=actor;await assert.rejects(()=>bindCountLimitFixtureRequests(client,changed),/changed after sealing/);
});
