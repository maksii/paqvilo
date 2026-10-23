import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFragment} from 'parse5';
import {DataStore} from '../lib/data.mjs';
import {renderComponent} from '../lib/platform.mjs';
import {submitPortalForm} from '../lib/form-service.mjs';

const currentClock=100000001, constant=100000000;
async function fixture({stored=null,mode=100000001,prepopulateType=currentClock,behavior='DateOnly'}={}) {
  const identity={contactId:'actor',roles:['Editor']};
  const field={name:'sample_day',label:'Day',dataverseType:'datetime',format:'date',dateTimeBehavior:behavior};
  const store=new DataStore({state:{mappings:{sample_widget:{entitySet:'sample_widgets',idColumn:'sample_widgetid',fields:{sample_day:field}}},tables:{sample_widget:[{sample_widgetid:'row',sample_day:stored}]},permissions:[{entity:'sample_widget',roles:['Editor'],operations:['read','create','update'],scope:'global'}],settings:{permissionMode:'enforce'}}});
  const options={store,identity,portal:{forms:[{id:'form',name:'Invented day',mode}],records:[{kind:'basicformmetadata',adx_entityform:'form',adx_type:100000000,adx_attributelogicalname:'sample_day',adx_prepopulatetype:prepopulateType,adx_prepopulatevalue:'2030-01-02T03:04:05.000Z'}],pages:[],website:{},settings:{}},schemas:{form:{entity:'sample_widget',fields:[field]}}};
  const before=store.snapshot();
  const html=await renderComponent('entityform','form',{user:identity,request:{params:mode===100000000?{}:{id:'row'}}},options);
  assert.deepEqual(store.snapshot(),before);
  let attrs;function visit(node){const a=Object.fromEntries((node.attrs??[]).map(x=>[x.name,x.value]));if(node.tagName==='input'&&a.id==='sample_day')attrs=a;for(const child of node.childNodes??[])visit(child);}visit(parseFragment(html));assert.ok(attrs);
  return{options,attrs,store};
}
for(const mode of[100000000,100000001,100000002])test('DateOnly current-clock winning prepopulation retains UTC suffix in mode '+mode,async()=>{
  const{attrs}=await fixture({mode});assert.match(attrs.value,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/);assert.equal(attrs['data-behavior'],'DateOnly');assert.equal(attrs['data-type'],'date');
});

test('explicit stored DateOnly value wins and retains the ordinary zone-free contract',async()=>{
 const{attrs}=await fixture({stored:'2030-01-02T00:00:00.0000000Z'});assert.equal(attrs.value,'2030-01-02T00:00:00.0000000');
});

test('constant prepopulation and TimeZoneIndependent clock behavior remain zone-free',async()=>{
 for(const config of[{prepopulateType:constant},{behavior:'TimeZoneIndependent'}]){const{attrs}=await fixture(config);assert.match(attrs.value,/\.\d{7}$/);assert.doesNotMatch(attrs.value,/Z$/);}
});

test('rendered current-clock DateOnly prefill and normal user-edited date both survive native postback and saved-row readback',async()=>{
 for(const edited of[false,true]){
  const{attrs,options,store}=await fixture();const value=edited?'2030-01-02T00:00:00.0000000':attrs.value;
  const saved=await submitPortalForm('entityform','form',{recordId:'row',values:{sample_day:value}},{...options,nativePostback:true});
  assert.equal(saved.operation,'update');const actual=store.get('sample_widget','row',options.identity).sample_day;
  assert.equal(String(actual).slice(0,10),value.slice(0,10));
 }
});

test('unqualified DateOnly/TZI/constant source cannot admit a posted UTC suffix; failed saves preserve rows',async()=>{
 for(const config of[{prepopulateType:null},{behavior:'TimeZoneIndependent'},{prepopulateType:constant}]){
  const{options,store}=await fixture(config);const before=store.snapshot();
  await assert.rejects(submitPortalForm('entityform','form',{recordId:'row',values:{sample_day:'2030-01-02T00:00:00.0000000Z'}},{...options,nativePostback:true}),error=>error.code==='FormFieldInvalid');
  assert.deepEqual(store.snapshot(),before);
 }
});
