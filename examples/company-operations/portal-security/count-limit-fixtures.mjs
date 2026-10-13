import {createHash} from 'node:crypto';
import {componentId} from './blueprint.mjs';
import {bindQualificationFixtureRequests} from './qualification-fixtures.mjs';

const guid=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Prepare disposable Stock equipment for an isolated native count-limit
 * probe. This planner and its metadata binder never execute business writes,
 * alter existing records, or change role/table-permission configuration. */
export function planCountLimitFixtures({schema,catalogue,actorContactId,runId,ownedRunId,resolvedIds,size=5010}) {
 if(![actorContactId,runId,ownedRunId].every(id=>guid.test(id??'')))throw new Error('Count-limit fixtures require actual actor and unique fixture/owned Run GUIDs.');
 if(!Number.isSafeInteger(size)||size<5001||size>5100)throw new Error('Count-limit fixture size must be bounded between 5001 and 5100.');
 const prototype=catalogue.records.find(row=>row.key==='CANARY-A-pqvd_equipment'),table=catalogue.tables.find(row=>row.name==='pqvd_equipment');
 if(!prototype||!table||!schema.tables.some(row=>row.name===table.name))throw new Error('Count-limit source equipment metadata/prototype is unavailable.');
 const reference=key=>{const row=catalogue.records.find(row=>row.key===key),id=resolvedIds?.[key];if(!row||!guid.test(id??''))throw new Error('Count-limit lookup lacks exact native binding: '+key);return {table:row.table,id,externalKey:key};};
 const token=runId.replaceAll('-',''),prefix=`CO Count limit ${token}`,records=Array.from({length:size},(_,index)=>({
  key:`QF-COUNT-${token}-${index+1}`,id:componentId(`count-limit:${runId}:${index+1}`),table:table.name,uniqueRunToken:token,
  fields:{...structuredClone(prototype.fields),pqvd_name:`${prefix} ${String(index+1).padStart(6,'0')}`,
    pqvd_assettag:`CO-CANARY-COUNT-${token}-${String(index+1).padStart(6,'0')}`,pqvd_equipmentstate:183270000},
  refs:{pqvd_accountid:reference(prototype.refs.pqvd_accountid),pqvd_roomid:reference(prototype.refs.pqvd_roomid),
    pqvd_currentassignmentid:null,pqvd_canaryrunid:{table:'pqvd_testrun',id:ownedRunId,externalRun:true}},deferredRefs:[],
 }));
 const fields=[{name:table.primaryId,source:table.primaryId,type:'guid',nullable:false}];
 const fetchXml=`<fetch count="5" page="{{page}}" returntotalrecordcount="true"><entity name="${table.name}"><attribute name="${table.primaryId}"></attribute><order attribute="${table.primaryId}"></order><filter type="and"><condition attribute="pqvd_name" operator="begins-with" value="${prefix}"></condition><condition attribute="pqvd_name" operator="ne" value="{{markerUtc}}"></condition><condition attribute="pqvd_name" operator="ne" value="{{markerOperation}}"></condition></filter></entity></fetch>`;
 const plan={schemaVersion:1,kind:'disposable-native-count-limit-fixture-requests',family:'count-limit',runId,ownedRunId,actorContactId,
  ownedRunActorReadbackRequired:true,records,associations:[],tables:structuredClone(catalogue.tables),
  configuration:{kind:'native-count-limit-first-page',minimumEligibleRecords:5001,fixtureRows:size,
    expectedTotalRecordCount:5000,expectedTotalRecordCountLimitExceeded:true,pageSize:5,
    qualification:'Pending native row-eligibility, original schema-2 DLL and source/data/version freeze'},
  query:{id:'COUNT-LIMIT',variant:'fetchxml',table:table.name,entitySet:table.entitySet,primaryId:table.primaryId,
    primaryName:'pqvd_name',pageSize:5,fields,fetchXml,logicalQueryHash:hash(fetchXml)},
  cleanup:records.map(row=>({table:row.table,id:row.id,expectedUniqueRunToken:token,requireCurrentETag:true,requireOwnedRecordReadback:true})),
  nativeDataVerified:false,nativeExecution:false,
  prerequisites:['Journal every intended create before the sole trusted native writer executes its metadata-bound request.',
    'Verify the existing room belongs to the declared account, and the Run belongs to the actual actor.',
    'Read back every generated fixture GUID, Stock state, null assignment, owning links and ETag; freeze that exact catalogue.',
    'Verify at least 5001 of these rows are eligible under the actual native permission footprint before asserting the count limit.',
    'Use five projected rows on the first physical page: this qualifies count-limit metadata, not all 5010 rows as portal retrieval coverage.',
    'Deploy/export/refreeze the schema-2 recorder first; old captures cannot qualify newly recorded object metadata.',
    'Archive exact owned fixture readbacks before conditional cleanup; existing seed equipment is outside this plan.'],
 };
 plan.planHash=hash(plan);return plan;
}

export async function bindCountLimitFixtureRequests(client,plan) {
 const {planHash,...sealed}=plan;
 if(plan.kind!=='disposable-native-count-limit-fixture-requests'||planHash!==hash(sealed))throw new Error('Count-limit fixture plan changed after sealing.');
 const tables=new Map(plan.tables.map(table=>[table.name,table])),first=plan.records[0],room=first.refs.pqvd_roomid,account=first.refs.pqvd_accountid;
 const read=async(table,id,column)=>{
  const row=await client.get(`${tables.get(table).entitySet}(${id})?$select=_${column}_value`),value=row[`_${column}_value`];
  if(!guid.test(value??''))throw new Error('Count-limit fixture owning hierarchy is incomplete.');return value;
 };
 const building=await read('pqvd_room',room.id,'pqvd_buildingid'),site=await read('pqvd_building',building,'pqvd_siteid');
 if(await read('pqvd_site',site,'pqvd_accountid')!==account.id)throw new Error('Count-limit fixture room does not belong to its owning account.');
 return {...await bindQualificationFixtureRequests(client,plan),owningHierarchyVerified:true};
}
