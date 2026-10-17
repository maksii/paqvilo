import {createHash} from 'node:crypto';
import {id} from './registration.mjs';

const guid=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const typeName='Paqvilo.Demo.QueryObservation.IncomingQueryObserver';

/** Omitted Primary Entity is an officially documented RetrieveMultiple
 * registration. This plan never changes or binds a forbidden currency filter.
 * Acceptance and actual currency invocation still require a native calibration;
 * registration alone is not a currency execution witness. No writes occur. */
export function planGlobalCurrencyObserverRegistration({metadata,pluginType,writerId,nonce,requiredAssemblySha256,existingStepIds=[],creationPath='disabled-create',disabledCreationEvidence}) {
 if(!['disabled-create','enabled-then-disable'].includes(creationPath))throw new Error('Unknown currency observer creation path.');
 if(creationPath==='enabled-then-disable'&&(disabledCreationEvidence?.status!==400||disabledCreationEvidence.code!=='0x80048408'||disabledCreationEvidence.stepAbsentVerified!==true||typeof disabledCreationEvidence.source!=='string'||!disabledCreationEvidence.source.trim()))throw new Error('Enabled creation requires the actual rejected disabled-Create fault and verified absent step evidence.');
 const messages=metadata?.messages?.filter(message=>message.name==='RetrieveMultiple'&&message.isprivate===false)??[];
 if(messages.length!==1||!guid.test(messages[0].sdkmessageid??''))throw new Error('An exact public native RetrieveMultiple message is required.');
 if(pluginType?.typename!==typeName||!guid.test(pluginType.plugintypeid??'')||![writerId,nonce].every(value=>guid.test(value??''))||!/^[a-f\d]{64}$/.test(requiredAssemblySha256??''))throw new Error('Exact native observer type, writer, fresh plan nonce and source assembly hash are required.');
 const currencyFilters=(metadata.filters??[]).filter(filter=>filter.primaryobjecttypecode==='transactioncurrency');
 if(currencyFilters.some(filter=>filter._sdkmessageid_value!==messages[0].sdkmessageid))throw new Error('Currency filter metadata belongs to a different SDK message.');
 const steps=[[10,10],[20,10],[20,9999],[40,9999]].map(([stage,rank])=>{
  const stepId=id(`qualification/global-currency/${nonce}/${stage}/${rank}`);
  if(existingStepIds.includes(stepId))throw new Error('Fresh currency-observer step identity already exists.');
  return {id:stepId,method:'POST',endpoint:'sdkmessageprocessingsteps',body:{sdkmessageprocessingstepid:stepId,
    name:`CO Currency Marker Observer ${nonce} S${stage} O${rank}`,stage,rank,mode:0,supporteddeployment:0,...(creationPath==='disabled-create'?{statecode:1,statuscode:2}:{}),
    description:'Temporary source-qualified global registration; only marked root currency queries with exact immutable intents may be observed.',
    configuration:JSON.stringify({schemaVersion:1,captureMode:'TransactionalLab',writerId,trustedWriterIds:[writerId],timeoutMs:2000,
      order:rank,configVersion:'currency-root-calibration-v2',observationTables:['transactioncurrency'],rootObservationOnly:true,
      allowAnonymousObservation:false,allowOwnedEvidenceDeletion:false}),
    'sdkmessageid@odata.bind':`/sdkmessages(${messages[0].sdkmessageid})`,'eventhandler_plugintype@odata.bind':`/plugintypes(${pluginType.plugintypeid})`},
    disabledAtCreation:creationPath==='disabled-create',
    ...(creationPath==='enabled-then-disable'?{disable:{method:'PATCH',endpoint:`sdkmessageprocessingsteps(${stepId})`,body:{statecode:1,statuscode:2},requireCurrentETag:true,requireExactCreateReadback:true}}:{}),
    readbackColumns:['sdkmessageprocessingstepid','statecode','statuscode','stage','rank','mode','configuration','_sdkmessageid_value','_sdkmessagefilterid_value','_eventhandler_value']};
 });
 const plan={schemaVersion:1,kind:'global-currency-marker-observer-calibration',nonce,requiredAssemblySha256,steps,
  creationPath,...(disabledCreationEvidence?{disabledCreationEvidence}:{}),sourceTableRestriction:['transactioncurrency'],rootOnly:true,tableSpecificFilterAllowed:currencyFilters.some(filter=>filter.iscustomprocessingstepallowed===true),
  nativeRegistrationAccepted:false,nativeCurrencyExecutionVerified:false,
  officialSources:['https://learn.microsoft.com/en-us/power-apps/developer/data-platform/register-plug-in',
    'https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/sdkmessageprocessingstep'],
  prerequisites:['Wait for all native source/role leases to restore before any registration or assembly deployment.',
    'Deploy and verify exact source-2 QueryObservation bytes before creating any step; old DLLs do not enforce the new table/root restriction.',
    creationPath==='disabled-create'?'Create disabled steps exactly as journalled; if the platform rejects disabled/global registration, stop and preserve the fault rather than change a filter or broaden scope.'
      :'Create each exact guarded step with platform-default Enabled state, immediately read back and conditionally disable it before proceeding to the next. Journal the intended create/disable before execution. No concurrent marked currency test is allowed in this short enabled interval.',
    'If create/disable outcome is uncertain, reconcile the exact owned GUID and configuration first; never retry blindly. A disable failure requires restoring that exact guarded owned step before continuing.',
    'Read back every step, verify omitted SDK filter, exact type/message/configuration and disabled state, then add the accepted components to the owned solution.',
    'Seal one fresh SDK-lane currency RetrieveMultiple intent with CO-UTC and CO-OP guards, trusted creator/Run ownership and exact root/message.',
    'Enable only these four owned steps under a restoration lease; capture an actual marked SDK currency query and independent unmarked/nested negative probes.',
    'Verify Stage10, Stage20 early/late and Stage40 original assembly artifacts, full checksum integrity and the actual unchanged runtime PrimaryEntityName.',
    'Disable the exact four owned steps in finally and read back restoration; export/re-read assembly and full registration before any new qualified campaign.',
    'If registration succeeds but currency execution produces no observer artifacts, currency backend query parity remains unqualified.'],
 };
 plan.planHash=createHash('sha256').update(JSON.stringify(plan)).digest('hex');return plan;
}

/** Standard supported filtered custom-reference observers and mutation guards.
 * Metadata must be read after publishing the new table. This never creates,
 * updates, enables or disables a native component. Existing steps require an
 * explicit reconciliation rather than being overwritten by a fresh plan. */
export function planCurrencyReferenceRegistration({metadata,observerType,guardType,writerId,requiredAssemblyHashes,existingStepIds=[]}){
 const table='pqvd_currencyreference',guardName='Paqvilo.Demo.PipelineTests.BusinessProjectionGuard';
 if(observerType?.typename!==typeName||guardType?.typename!==guardName||![observerType.plugintypeid,guardType.plugintypeid,writerId].every(value=>guid.test(value??'')))throw new Error('Exact native observer/guard type identities and fixture writer are required.');
 for(const name of ['Paqvilo.Demo.QueryObservation','Paqvilo.Demo.PipelineTests'])if(!/^[a-f\d]{64}$/.test(requiredAssemblyHashes?.[name]??''))throw new Error('Both source-qualified installed assembly hashes are required.');
 const definitions=[...[[10,10],[20,10],[20,9900],[40,9900]].map(([stage,rank])=>({type:'IncomingQueryObserver',typeId:observerType.plugintypeid,message:'RetrieveMultiple',stage,rank})),...['Create','Update','Delete'].map(message=>({type:'BusinessProjectionGuard',typeId:guardType.plugintypeid,message,stage:20,rank:5}))];
 const steps=definitions.map(definition=>{
  const messages=(metadata?.messages??[]).filter(row=>row.name===definition.message&&row.isprivate===false);if(messages.length!==1||!guid.test(messages[0].sdkmessageid??''))throw new Error('Exact public SDK message metadata is required for '+definition.message);
  const messageId=messages[0].sdkmessageid,filters=(metadata.filters??[]).filter(row=>row._sdkmessageid_value===messageId&&row.primaryobjecttypecode===table&&row.iscustomprocessingstepallowed===true&&row.isvisible===true);
  if(filters.length!==1||!guid.test(filters[0].sdkmessagefilterid??''))throw new Error('Exactly one supported visible custom-table filter is required for '+definition.message);
  const stepId=id(`step/${definition.type}/${table}/${definition.message}/${definition.stage}/${definition.rank}/0`);if(existingStepIds.includes(stepId))throw new Error('An owned reference step already exists; reconcile exact metadata/state before reuse.');
  return {id:stepId,method:'POST',endpoint:'sdkmessageprocessingsteps',body:{sdkmessageprocessingstepid:stepId,name:`CO ${definition.type}: ${definition.message} ${table} S${definition.stage} O${definition.rank} M0`,description:'Owned custom currency-reference lab. Immutable fixture metadata; original actor/intent-bound query observations.',stage:definition.stage,rank:definition.rank,mode:0,supporteddeployment:0,
   configuration:JSON.stringify({schemaVersion:1,captureMode:'TransactionalLab',writerId,trustedWriterIds:[writerId],timeoutMs:2000,order:definition.rank,configVersion:'currency-reference-v1',allowAnonymousObservation:false,allowOwnedEvidenceDeletion:false}),
   'sdkmessageid@odata.bind':`/sdkmessages(${messageId})`,'sdkmessagefilterid@odata.bind':`/sdkmessagefilters(${filters[0].sdkmessagefilterid})`,'eventhandler_plugintype@odata.bind':`/plugintypes(${definition.typeId})`},requireExactReadback:true,addSolutionComponent:{type:92,solution:'PaqviloBehaviorPlugins'},images:[]};
 });
 const plan={schemaVersion:1,kind:'filtered-custom-currency-reference-registration',table,requiredAssemblyHashes,steps,nativeRegistrationAccepted:false,nativeExecutionVerified:false,
  prerequisites:['Publish the new custom table, then capture exact supported message/filter/type metadata.', 'Install and read back exact guarded DLL hashes before any step create; no global or forbidden system-currency filter is changed.', 'Journal each exact POST and reconcile uncertain outcomes by owned GUID/configuration before retry.', 'Read back exact enabled step/type/filter/rank/configuration and add all seven to the owned plugin solution.', 'Retain both existing global projection guards; verify the new N:N association rejects non-trusted callers.', 'Export installed assemblies and registrations, freeze the custom reference data/projections/site sources and capture actual two-lane query witnesses before crediting parity.']};
 plan.planHash=createHash('sha256').update(JSON.stringify(plan)).digest('hex');return plan;
}
