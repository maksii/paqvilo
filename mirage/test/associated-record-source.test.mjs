import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFormRecord as candidate } from '../lib/platform.mjs';

const actor='10000000-0000-4000-8000-000000000001';
const first='20000000-0000-4000-8000-000000000001';
const second='20000000-0000-4000-8000-000000000002';
function fixture({rows=[],kind='entityform',allowCreate=false,singular=false}={}){
 const identity={contactId:actor},calls=[];
 const metadata={adx_entitysourcetype:kind==='webform'?100000004:756150003,adx_recordsourcerelationshipname:'sample_contact_widgets',adx_recordsourceallowcreateonnull:allowCreate};
 const schema={mode:100000001,metadata};
 const store={resolveMapping:entity=>entity==='contact'?{relationships:{sample_contact_widgets:{schemaName:'sample_contact_widgets',many:!singular,entity:'sample_widget',to:'sample_contactid',from:'sample_widgetid'}}}:{idColumn:'sample_widgetid'}};
 const readProvider={query:async(entity,query,principal)=>{assert.equal(entity,'sample_widget');assert.strictEqual(principal,identity);assert.equal(query.$filter,`sample_contactid eq ${actor}`);calls.push(query);return{value:rows.slice(0,query.$top)}},get:async(entity,id,principal)=>{assert.equal(entity,'contact');assert.equal(id,actor);assert.strictEqual(principal,identity);return{sample_widgetid:first}}};
 return{options:{kind,schema,definition:{},context:{request:{params:{}}},store,identity,readProvider},calls};
}

for(const kind of ['entityform','webform']){
 test(`candidate refuses ambiguous ${kind} associated source without inventing a selected row`,async()=>{
  const {options,calls}=fixture({kind,rows:[{sample_widgetid:first},{sample_widgetid:second}],allowCreate:true});
  await assert.rejects(candidate(options),error=>error.status===500&&error.code==='FORM_RECORD_SOURCE_AMBIGUOUS');assert.equal(calls[0].$top,2);
 });
}
test('exactly one permitted associated record retains its existing identity/mode and principal',async()=>{
 const {options,calls}=fixture({rows:[{sample_widgetid:first}]});
 assert.deepEqual(await candidate(options),{mode:100000001,id:first,sourceType:756150003});assert.equal(calls[0].$top,2);
});
test('empty source retains authored allow-create-if-null behavior',async()=>{
 for(const allowCreate of [false,true]){
  const {options}=fixture({allowCreate});
  assert.deepEqual(await candidate(options),allowCreate?{mode:100000000,id:null,createOnNull:true}:{mode:100000001,id:null,sourceType:756150003});
 }
});
test('singular lookup source still resolves the authorized contact lookup directly',async()=>{
 const {options,calls}=fixture({singular:true});
 assert.equal((await candidate(options)).id,first);assert.equal(calls.length,0);
});
test('explicit record binding and ordinary query sources remain untouched',async()=>{
 const {options,calls}=fixture({rows:[{sample_widgetid:first},{sample_widgetid:second}]});
 options.schema.recordId=second;assert.equal((await candidate(options)).id,second);assert.equal(calls.length,0);
 delete options.schema.recordId;options.schema.metadata={adx_entitysourcetype:756150001};options.context.request.params.id=first;
 assert.equal((await candidate(options)).id,first);assert.equal(calls.length,0);
});
test('read-provider security failure propagates without fallback to a hidden row or create mode',async()=>{
 const {options}=fixture({allowCreate:true});
 options.readProvider.query=async()=>{throw Object.assign(Error('Invented denied row read'),{status:403})};
 await assert.rejects(candidate(options),error=>error.status===403);
});
