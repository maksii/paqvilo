import test from 'node:test';
import assert from 'node:assert/strict';
import {planGlobalCurrencyObserverRegistration,planCurrencyReferenceRegistration} from '../currency-observer-plan.mjs';

const id='10000000-0000-0000-0000-000000000001';
const fixture=()=>({metadata:{messages:[{sdkmessageid:id,name:'RetrieveMultiple',isprivate:false}],filters:[{primaryobjecttypecode:'transactioncurrency',_sdkmessageid_value:id,iscustomprocessingstepallowed:false}]},pluginType:{typename:'Paqvilo.Demo.QueryObservation.IncomingQueryObserver',plugintypeid:id},writerId:id,nonce:id,requiredAssemblySha256:'a'.repeat(64)});
test('custom reference packet requires supported exact filtered messages and preserves immutable source authority',()=>{
 const messages=['RetrieveMultiple','Create','Update','Delete'].map((name,index)=>({name,isprivate:false,sdkmessageid:`10000000-0000-0000-0000-${String(index+1).padStart(12,'0')}`}));
 const input={metadata:{messages,filters:messages.map(message=>({primaryobjecttypecode:'pqvd_currencyreference',_sdkmessageid_value:message.sdkmessageid,sdkmessagefilterid:message.sdkmessageid,isvisible:true,iscustomprocessingstepallowed:true}))},observerType:{typename:'Paqvilo.Demo.QueryObservation.IncomingQueryObserver',plugintypeid:id},guardType:{typename:'Paqvilo.Demo.PipelineTests.BusinessProjectionGuard',plugintypeid:id},writerId:id,requiredAssemblyHashes:{'Paqvilo.Demo.QueryObservation':'a'.repeat(64),'Paqvilo.Demo.PipelineTests':'b'.repeat(64)}};
 const before=structuredClone(input),plan=planCurrencyReferenceRegistration(input);assert.deepEqual(input,before);assert.equal(plan.steps.length,7);assert.equal(plan.nativeExecutionVerified,false);assert.equal(new Set(plan.steps.map(step=>step.id)).size,7);
 for(const step of plan.steps){assert.ok(step.body['sdkmessagefilterid@odata.bind']);assert.equal(step.body.mode,0);assert.deepEqual(JSON.parse(step.body.configuration).trustedWriterIds,[id]);assert.equal(step.body['impersonatinguserid@odata.bind'],undefined);}
 assert.deepEqual(plan.steps.filter(step=>step.body.configuration.includes('9900')).map(step=>[step.body.stage,step.body.rank]),[[20,9900],[40,9900]]);
 for(const mutation of [x=>x.metadata.filters[0].iscustomprocessingstepallowed=false,x=>x.metadata.filters[0].primaryobjecttypecode='transactioncurrency',x=>x.metadata.filters.push(x.metadata.filters[0]),x=>x.metadata.messages[0].isprivate=true,x=>x.requiredAssemblyHashes['Paqvilo.Demo.PipelineTests']=null]){const invalid=structuredClone(input);mutation(invalid);assert.throws(()=>planCurrencyReferenceRegistration(invalid));}
 assert.throws(()=>planCurrencyReferenceRegistration({...input,existingStepIds:[plan.steps[0].id]}),/reconcile/);
});

test('currency calibration plans disabled unfiltered steps without bypassing forbidden metadata',()=>{
 const input=fixture(),before=structuredClone(input),plan=planGlobalCurrencyObserverRegistration(input);
 assert.deepEqual(input,before);assert.equal(plan.steps.length,4);assert.equal(plan.tableSpecificFilterAllowed,false);
 assert.equal(plan.nativeCurrencyExecutionVerified,false);assert.equal(plan.nativeRegistrationAccepted,false);
 assert.equal(new Set(plan.steps.map(step=>step.id)).size,4);
 for(const step of plan.steps){assert.equal(step.body.statecode,1);assert.equal(step.body.statuscode,2);assert.equal(Object.hasOwn(step.body,'sdkmessagefilterid@odata.bind'),false);const config=JSON.parse(step.body.configuration);assert.deepEqual(config.observationTables,['transactioncurrency']);assert.equal(config.rootObservationOnly,true);assert.equal(config.allowAnonymousObservation,false);}
 assert.throws(()=>planGlobalCurrencyObserverRegistration({...input,existingStepIds:[plan.steps[0].id]}),/already exists/);
 assert.throws(()=>planGlobalCurrencyObserverRegistration({...input,metadata:{...input.metadata,messages:[{...input.metadata.messages[0],isprivate:true}]}}),/public native/);
 assert.throws(()=>planGlobalCurrencyObserverRegistration({...input,requiredAssemblySha256:null}),/assembly hash/);
});

test('enabled-default creation is explicit, source-attested and immediately paired with conditional disable',()=>{
 const input=fixture();assert.throws(()=>planGlobalCurrencyObserverRegistration({...input,creationPath:'enabled-then-disable'}),/actual rejected/);
 const plan=planGlobalCurrencyObserverRegistration({...input,creationPath:'enabled-then-disable',disabledCreationEvidence:{status:400,code:'0x80048408',stepAbsentVerified:true,source:'Invented rejected Create receipt'}});
 for(const step of plan.steps){assert.equal(Object.hasOwn(step.body,'statecode'),false);assert.equal(Object.hasOwn(step.body,'statuscode'),false);assert.equal(step.disabledAtCreation,false);assert.deepEqual(step.disable.body,{statecode:1,statuscode:2});assert.equal(step.disable.requireCurrentETag,true);assert.equal(step.disable.requireExactCreateReadback,true);assert.equal(Object.hasOwn(step.body,'sdkmessagefilterid@odata.bind'),false);}
});
