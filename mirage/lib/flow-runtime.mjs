import {DataError} from './data-error.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {validateServiceProfile} from './local-organization-service.mjs';
import {createConnectorRuntime,connectorOf,referenceOf,parseRetryPolicy,durationMs,dataverseParameters,CHANGESET_OPERATIONS,DATAVERSE_CONNECTOR,CHILD_FLOW_CONNECTOR} from './connector-runtime.mjs';
import {FLOW_ACTIONS,CONTROL_ACTIONS} from './flow-actions.mjs';
import {WINDOWS_TIME_ZONES} from './windows-time-zones.mjs';
import {effectiveEnvironmentVariables} from './secret-resolver.mjs';
import {isExactNumeric,parseNumericLiteral,parseExactJson,stringifyExactJson,decimalParts,compareNumeric,sumNumeric,multiplyNumeric,divideNumeric,exactNumeric} from './exact-numeric.mjs';
const own=(o,k)=>o!=null&&Object.hasOwn(o,k), clone=v=>v===undefined?null:structuredClone(v);
const fail=(message,status=501,code='LocalFlowUnsupported')=>{throw new DataError(message,status,code);};
const unsafe=k=>['__proto__','constructor','prototype'].includes(k);
// Action results of a loop iteration layer over the enclosing results (Object.create), so an iteration reads its own actions first.
const hasResult=(results,name)=>{if(unsafe(String(name)))return false;for(let at=results;at&&at!==Object.prototype;at=Object.getPrototypeOf(at))if(Object.hasOwn(at,name))return true;return false;};
const builtins=new Set([...CONTROL_ACTIONS,...Object.keys(FLOW_ACTIONS)]);
// A variable that an action writes (concurrent branches writing the same one need an explicit mock).
const WRITES=new Set(['SetVariable','IncrementVariable','DecrementVariable','AppendToArrayVariable','AppendToStringVariable']);
/** Child flow nesting and trigger chain depth share this bound (flow-triggers.mjs). */
export const FLOW_MAX_DEPTH=16;
// A waiting action stops the interpreter: executeFlowDefinition answers { status: 'Waiting', suspended } instead of failing.
class FlowSuspended extends Error{constructor(actionPath,wait){super('The flow run is waiting.');this.actionPath=actionPath;this.wait=wait;}}
// Wait action delay (Workflow Definition Language Wait: inputs.interval { count, unit } or inputs.until.timestamp).
const UNIT_MS={Second:1000,Minute:60000,Hour:3600000,Day:86400000,Week:604800000};
// Without an explicit connector runtime only the built-in Dataverse provider is routed (unchanged synchronous behaviour).
const legacyRuntime=createConnectorRuntime();
// The connector call an action or trigger makes, or null for built-in actions.
const connectorCall=action=>action?.type==='Http'?{connectorId:'http',operationId:'Http',connectionName:null}:action?.type==='Workflow'?{connectorId:CHILD_FLOW_CONNECTOR,operationId:'RunChildFlow',connectionName:null}:['OpenApiConnection','OpenApiConnectionWebhook'].includes(action?.type)&&action.inputs?.host?.apiId?{connectorId:connectorOf(action.inputs.host.apiId),operationId:action.inputs.host.operationId??null,connectionName:action.inputs.host.connectionName??null}:null;
const paginationOk=value=>value&&typeof value==='object'&&Object.keys(value).length===1&&Number.isInteger(value.minimumItemCount)&&value.minimumItemCount>0&&value.minimumItemCount<=100000;
const secureOk=value=>value&&typeof value==='object'&&Object.keys(value).length===1&&Array.isArray(value.properties)&&value.properties.every(p=>['inputs','outputs'].includes(p));
// A connector action's runtimeConfiguration: paginationPolicy and secureData (outputs are then never journalled).
const runtimeConfigurationOk=(value,dataverse)=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length>0&&Object.entries(value).every(([k,v])=>k==='paginationPolicy'?paginationOk(v):k==='secureData'&&secureOk(v));
// A Foreach's runtimeConfiguration.concurrency.repetitions (1-50): the degree of parallelism of its iterations
// (https://learn.microsoft.com/azure/logic-apps/logic-apps-workflow-actions-triggers#change-for-each-concurrency).
const foreachConcurrencyOk=value=>Boolean(value)&&typeof value==='object'&&Object.keys(value).length===1&&value.concurrency&&typeof value.concurrency==='object'&&Object.keys(value.concurrency).length===1&&Number.isInteger(value.concurrency.repetitions)&&value.concurrency.repetitions>=1&&value.concurrency.repetitions<=50;
// operationOptions an action may carry locally: Sequential on a Foreach, DisableAsyncPattern on an HTTP or connector action
// (https://learn.microsoft.com/azure/logic-apps/logic-apps-workflow-actions-triggers#operation-options).
const operationOptionsOk=(action,connector)=>typeof action.operationOptions==='string'&&action.operationOptions.split(',').map(s=>s.trim()).every(o=>o==='Sequential'&&action.type==='Foreach'||o==='DisableAsyncPattern'&&connector);
// Binding of one call: the reference it names, whether it resolves to a usable connection, and the provider.
function bindingOf(runtime,call,{connectionReferences,principal}={}){
 try{const r=runtime.resolve({...call,connectionReferences,principal});return {referenceLogicalName:r.referenceLogicalName,bound:r.bound,provider:r.provider,connectionId:r.connectionId};}
 catch(error){if(!error.code)throw error;return {referenceLogicalName:referenceOf(connectionReferences,call.connectionName),bound:false,provider:null,connectionId:null};}
}
const unsupportedTriggerSettings=['runtimeConfiguration','runTimeConfiguration','conditions','splitOn','recurrence','operationOptions'];
const responseStatus=code=>Number.isInteger(code)&&code>=200&&code<=599&&(code<300||code>=400);
// Recurrence (https://learn.microsoft.com/azure/connectors/connectors-native-recurrence#add-the-recurrence-trigger): frequency
// Second..Month, interval, optional startTime and timeZone, and a schedule of hours and minutes (Day, Week, Month), weekDays
// (Week) and monthDays (Month, -1 the last day: #workflow-definition---recurrence). timeZone is an IANA name resolved through
// Intl (no time-zone table): a startTime without Z or offset is wall-clock time in it; with Z the zone is ignored (Learn).
export const RECURRENCE_FREQUENCIES=Object.freeze({Second:1000,Minute:60000,Hour:3600000,Day:86400000,Week:604800000,Month:null});
export const WEEK_DAYS=Object.freeze(['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']);
const zoneFormats=new Map();
/** The wall-clock parts of an instant in an IANA time zone (month 0-based). */
export function zoneParts(ms,zone){
 let format=zoneFormats.get(zone);if(!format)zoneFormats.set(zone,format=new Intl.DateTimeFormat('en-US',{timeZone:zone,hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric'}));
 const p=Object.fromEntries(format.formatToParts(ms).map(x=>[x.type,Number(x.value)]));return {year:p.year,month:p.month-1,day:p.day,hour:p.hour,minute:p.minute,second:p.second};
}
/** The instant of a wall-clock time in a zone. A time in a daylight-saving gap keeps the offset before the change and a repeated
 * time takes its first instant, as the Learn DST tables show (concepts-schedule-automated-recurring-tasks-workflows). */
export function zonedInstant({year,month,day,hour=0,minute=0,second=0},zone){
 const wall=Date.UTC(year,month,day,hour,minute,second),offset=at=>{const p=zoneParts(at,zone);return Date.UTC(p.year,p.month,p.day,p.hour,p.minute,p.second)-Math.floor(at/1000)*1000;};
 const first=wall-offset(wall),second2=wall-offset(first);if(second2===first)return first;
 const p=zoneParts(second2,zone);return Date.UTC(p.year,p.month,p.day,p.hour,p.minute,p.second)===wall?second2:first;
}
const knownZone=zone=>{try{new Intl.DateTimeFormat('en-US',{timeZone:zone});return true;}catch{return false;}};
export function parseRecurrence(value){
 const errors=[];if(!value||typeof value!=='object'||Array.isArray(value))return {errors:['A recurrence needs { frequency, interval }.']};
 for(const key of Object.keys(value))if(!['frequency','interval','startTime','timeZone','schedule'].includes(key))errors.push('Unsupported recurrence setting: '+key+'; configure an explicit flow mock or disable it.');
 if(!own(RECURRENCE_FREQUENCIES,value.frequency))errors.push('Recurrence frequency must be Second, Minute, Hour, Day, Week or Month.');
 const interval=Number(value.interval??1);if(!Number.isInteger(interval)||interval<1)errors.push('Recurrence interval must be a positive integer.');
 // An IANA name Intl knows is used as is; a Windows id maps through the CLDR windowsZones table (windows-time-zones.mjs).
 // unverified: 'Coordinated Universal Time' (a Windows display name) as UTC.
 const named=value.timeZone===undefined||value.timeZone==='Coordinated Universal Time'?'UTC':String(value.timeZone);
 const zone=knownZone(named)?named:WINDOWS_TIME_ZONES[named]??named;
 if(!knownZone(zone))errors.push('Recurrence timeZone '+value.timeZone+' is neither a Windows time-zone id in the CLDR table nor an IANA time zone the local Intl database knows.');
 const text=String(value.startTime??''),local=value.startTime!==undefined&&!/[zZ]|[+-]\d\d:?\d\d$/.test(text),wall=/^(\d{4})-(\d\d)-(\d\d)T(\d{1,2}):(\d\d)(?::(\d\d))?(?:\.\d+)?$/.exec(text);
 const start=value.startTime===undefined?null:local&&zone!=='UTC'&&errors.length===0?(wall?zonedInstant({year:+wall[1],month:+wall[2]-1,day:+wall[3],hour:+wall[4],minute:+wall[5],second:+(wall[6]??0)},zone):NaN):Date.parse(local?text+'Z':text);
 if(value.startTime!==undefined&&!Number.isFinite(start))errors.push('Recurrence startTime must be a date.');
 let schedule=null;
 if(value.schedule!==undefined){
  const s=value.schedule,ints=(v,min,max,name)=>{const list=[v].flat();if(!list.length||list.some(n=>!Number.isInteger(n)||(n<min||n>max)&&!(name==='monthDays'&&n===-1)))errors.push('Recurrence schedule '+name+' must be integers from '+(name==='monthDays'?'1 to 31 or -1':min+' to '+max)+'.');return [...new Set(list)].sort((a,b)=>a-b);};
  if(!s||typeof s!=='object'||Array.isArray(s))errors.push('Recurrence schedule must be an object.');
  else{
   schedule={};for(const key of Object.keys(s))if(!['hours','minutes','weekDays','monthDays'].includes(key))errors.push('Unsupported recurrence schedule setting: '+key+'; configure an explicit flow mock or disable it.');
   if(!['Day','Week','Month'].includes(value.frequency))errors.push('A recurrence schedule needs the Day, Week or Month frequency.');
   if(s.hours!==undefined)schedule.hours=ints(s.hours,0,23,'hours');if(s.minutes!==undefined)schedule.minutes=ints(s.minutes,0,59,'minutes');
   if(s.weekDays!==undefined){const days=[s.weekDays].flat();if(value.frequency!=='Week')errors.push('Recurrence schedule weekDays needs the Week frequency.');if(!days.length||days.some(d=>!WEEK_DAYS.includes(d)))errors.push('Recurrence schedule weekDays must name Monday to Sunday.');schedule.weekDays=[...new Set(days.map(d=>WEEK_DAYS.indexOf(d)))];}
   if(s.monthDays!==undefined){if(value.frequency!=='Month')errors.push('Recurrence schedule monthDays needs the Month frequency.');schedule.monthDays=ints(s.monthDays,1,31,'monthDays');}
  }
 }
 return {errors,frequency:value.frequency,interval,start,zone,schedule};
}
const unsupportedTrigger=(trigger,detail='')=>({supported:false,kind:trigger.type??'unknown',errors:['Unsupported trigger '+(trigger.type??'unknown')+'/'+(trigger.kind??trigger.inputs?.host?.operationId??'')+detail+'; configure an explicit flow mock or disable it.']});
/** The trigger kind a definition runs locally: manual (Button), powerpages, http (Request kind Http, started on demand),
 * recurrence, dataverse (row trigger) or connector (a pack flowTriggers entry; pass the connector runtime as connectors). */
export function inspectFlowTrigger(definition,{connectors}={}){
 const triggers=Object.values(definition?.triggers??{});if(triggers.length!==1)return {supported:false,kind:'unknown',errors:['One source trigger is required.']};
 const trigger=triggers[0],apiId=String(trigger.inputs?.host?.apiId??''),operationId=trigger.inputs?.host?.operationId??null,dataverse=apiId.endsWith('/shared_commondataserviceforapps')&&operationId==='SubscribeWebhookTrigger';
 const performed=apiId.endsWith('/shared_commondataserviceforapps')&&operationId==='BusinessEventsTrigger';
 // A Recurrence trigger and a polling connector trigger carry their own recurrence; on any other trigger it is unsupported.
 const ownRecurrence=trigger.type==='Recurrence'||['OpenApiConnectionWebhook','OpenApiConnection'].includes(trigger.type)&&!dataverse&&!performed;
 const settingErrors=unsupportedTriggerSettings.filter(key=>own(trigger,key)&&!(key==='recurrence'&&ownRecurrence)).map(key=>'Unsupported source trigger setting: '+key);
 const requestInputs=allowed=>{for(const key of Object.keys(trigger.inputs??{}))if(!allowed.includes(key))settingErrors.push('Unsupported Request trigger input: '+key);};
 // unverified: the child flow's manual trigger kind (Button); the child needs a Response to answer its parent.
 if(trigger.type==='Request'&&trigger.kind==='Button'){requestInputs(['schema']);return {supported:!settingErrors.length,kind:'manual',errors:settingErrors};}
 if(trigger.type==='Request'&&trigger.kind==='powerpages'){requestInputs(['schema']);return {supported:!settingErrors.length,kind:'powerpages',errors:settingErrors};}
 // A plain HTTP Request trigger runs on demand (/_sim/api/flow-triggers/<flowId>) and from its signed callback URL
 // (flow-triggers.mjs flowCallbackUrl; method and schema checked by sim-flow-routes.mjs).
 if(trigger.type==='Request'&&trigger.kind==='Http'){requestInputs(['schema','method']);if(trigger.inputs?.method!==undefined&&!/^[A-Za-z]+$/.test(String(trigger.inputs.method)))settingErrors.push('Request trigger method must be an HTTP method.');return {supported:!settingErrors.length,kind:'http',method:trigger.inputs?.method?String(trigger.inputs.method).toUpperCase():null,errors:settingErrors};}
 if(trigger.type==='Recurrence'){const recurrence=parseRecurrence(trigger.recurrence);settingErrors.push(...recurrence.errors);return {supported:!settingErrors.length,kind:'recurrence',recurrence:recurrence.errors.length?null:{frequency:recurrence.frequency,interval:recurrence.interval,start:recurrence.start,zone:recurrence.zone,schedule:recurrence.schedule},errors:settingErrors};}
 // "When an action is performed" (https://learn.microsoft.com/connectors/commondataserviceforapps/#when-an-action-is-performed,
 // https://learn.microsoft.com/power-automate/dataverse/action-trigger): catalog, category, entityname, sdkmessagename; it fires
 // each time the action completes. unverified: the exported parameter keys (the connector reference keys, optionally with the
 // subscriptionRequest/ prefix of the row trigger) and 'none' for an unbound action's table.
 if(performed&&trigger.type==='OpenApiConnectionWebhook'){
  const p={};for(const[key,value]of Object.entries(trigger.inputs?.parameters??{})){const field=key.replace(/^subscriptionRequest\//,'');if(!['catalog','category','entityname','sdkmessagename'].includes(field)||own(p,field))settingErrors.push('Unsupported Dataverse action trigger parameter: '+key);else p[field]=value;}
  if(typeof p.sdkmessagename!=='string'||!/^[A-Za-z_][\w.]*$/.test(p.sdkmessagename))settingErrors.push('The Dataverse action trigger needs an action name (sdkmessagename).');
  const table=p.entityname==null||['','none','(none)'].includes(String(p.entityname).toLowerCase())?null:String(p.entityname);if(table!==null&&!/^[a-z][\w]*$/i.test(table))settingErrors.push('Dataverse action trigger table must be a logical name or none.');
  return {supported:!settingErrors.length,kind:'dataverse-action',message:p.sdkmessagename??null,table,catalog:p.catalog??null,category:p.category??null,errors:settingErrors};
 }
 if(['OpenApiConnectionWebhook','OpenApiConnection'].includes(trigger.type)&&!dataverse){
  const connectorId=connectorOf(apiId),hosted=connectors?.flowTriggers?.(connectorId,operationId);
  if(!hosted)return unsupportedTrigger(trigger,' ('+connectorId+'; no pack flowTriggers entry hosts it)');
  // A managed polling trigger computes its next run from frequency and interval only; schedule options do not apply and the
  // time zone sets only the start (https://learn.microsoft.com/azure/logic-apps/concepts-schedule-automated-recurring-tasks-workflows#recurrence-for-managed-triggers).
  let recurrence=null;if(own(trigger,'recurrence')){const parsed=parseRecurrence(trigger.recurrence);settingErrors.push(...parsed.errors);recurrence={frequency:parsed.frequency,interval:parsed.interval,start:parsed.start};if(typeof hosted.poll!=='function')settingErrors.push('The pack flowTriggers entry for '+connectorId+'/'+operationId+' has no poll function for a recurrence.');}
  return {supported:!settingErrors.length,kind:'connector',connectorId,operationId,polling:own(trigger,'recurrence'),...(recurrence&&!settingErrors.length?{recurrence}:{}),errors:settingErrors};
 }
 if(!['OpenApiConnectionWebhook','OpenApiConnection'].includes(trigger.type))return unsupportedTrigger(trigger);
 const raw=trigger.inputs.parameters??{},p={};const errors=[];
 for(const[key,value]of Object.entries(raw)){const field=key.replace(/^subscriptionRequest\//,'');if(!['message','entityname','scope','filteringattributes','filterexpression'].includes(field)||Object.hasOwn(p,field))errors.push('Unsupported Dataverse trigger parameter: '+key);else p[field]=value;}
 if(!/^[a-z][\w]*$/i.test(p.entityname??''))errors.push('Dataverse trigger table is missing.');
 if(![1,2,3,4,5,6,7].includes(p.message))errors.push('Dataverse trigger change type must be an exported callback-registration message1-7.');
 if(p.scope!==4)errors.push('Dataverse trigger scope requires an identity/ownership adapter; only explicit Organization(4) is implemented.');
 errors.push(...settingErrors);
 if(p.filteringattributes!==undefined&&(typeof p.filteringattributes!=='string'||(p.filteringattributes.trim()!==''&&p.filteringattributes.split(',').some(v=>!/^\s*[a-z][\w]*\s*$/i.test(v)))))errors.push('Trigger select columns require scalar logical names.');
 if(p.filterexpression!==undefined&&typeof p.filterexpression!=='string')errors.push('Trigger filter must be a source OData string.');
 return {supported:!errors.length,kind:'dataverse',table:p.entityname,message:p.message,scope:p.scope,selectColumns:typeof p.filteringattributes==='string'&&p.filteringattributes.trim()?p.filteringattributes.split(',').map(s=>s.trim()):[],filter:p.filterexpression??null,errors};
}
function equivalent(a,b){
 if(isExactNumeric(a)||isExactNumeric(b))return compareNumeric(a,b)===0;
 if(typeof a==='boolean'&&typeof b==='number'||typeof b==='boolean'&&typeof a==='number')return Number(a)===Number(b);
 if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 const ak=Object.keys(a),bk=Object.keys(b);return ak.length===bk.length&&ak.every(k=>own(b,k)&&equivalent(a[k],b[k]));
}
function numericKind(node,state){
 if(node.kind==='literal')return node.numericType??(Number.isInteger(node.value)?'integer':'float');
 if(node.kind==='call'){
  const name=node.name.toLowerCase();if(name==='float')return 'float';if(name==='int')return 'integer';
  if(name==='variables')return state.variables[evaluate(node.args[0],state)]?.type??'unknown';
  if(['add','sub','mul','div','mod'].includes(name))return node.args.every(n=>numericKind(n,state)==='integer')?'integer':'float';
 }
 if(node.kind==='property'){const value=evaluate(node,state);if(isExactNumeric(value))return decimalParts(value).scale===0?'integer':'decimal';}
 // JSON does not retain whether a numeric source token was 5 or 5.0.
 return 'unknown';
}
export function inspectFlowDefinition(definition,steps={},{connectors,connectionReferences,principal,maxIterations=100}={}){
 const actions=[],errors=[],connections=new Map(),runtime=connectors??legacyRuntime,packActions=runtime.flowActions?.()??{};let count=0,badRequest=false,parallel=0;
 const bind=(call,key)=>{const binding=bindingOf(runtime,call,{connectionReferences,principal}),id=call.connectionName??call.connectorId,entry=connections.get(id)??{name:call.connectionName,connectorId:call.connectorId,referenceLogicalName:binding.referenceLogicalName,connectionId:binding.connectionId,provider:binding.provider,bound:binding.bound,usedBy:[]};entry.usedBy.push(key);connections.set(id,entry);return binding;};
 const visit=(map,prefix='',depth=0,inheritedSkip=false,inLoop=false)=>{if(depth>16||!map||typeof map!=='object'||Array.isArray(map)){errors.push('Invalid or excessive action nesting.');return;}for(const[name,action]of Object.entries(map)){
  const key=prefix+name;count++;if(unsafe(name)||!action||typeof action!=='object'){errors.push('Invalid action '+key);continue;}
  const override=steps[key],mode=override?.mode??'exported';
  const call=['OpenApiConnection','OpenApiConnectionWebhook','Http','Workflow'].includes(action.type)?connectorCall(action):null,dataverse=call?.connectorId===DATAVERSE_CONNECTOR&&action.type==='OpenApiConnection';
  const routed=Boolean(call)&&(Boolean(connectors)||dataverse||call.connectorId===CHILD_FLOW_CONNECTOR),connection=routed?bind(call,key):null;
  const connector=routed&&runtime.supports(call.connectorId,call.operationId,connection.provider??undefined)&&(connection.bound||!call.connectionName);
  const packAction=!call&&own(packActions,action.type),supported=builtins.has(action.type)||packAction||connector;actions.push({key,name,type:action.type,operationId:action.inputs?.host?.operationId??null,supported,mode,external:action.type==='OpenApiConnection'&&!(dataverse&&connector)||['Http','ApiConnection','ApiConnectionWebhook','OpenApiConnectionWebhook'].includes(action.type),...(connection?{connection:{referenceLogicalName:connection.referenceLogicalName,bound:connection.bound,provider:connection.provider}}:{})});
  if(!inheritedSkip&&!supported&&!['mock','disabled'].includes(mode))errors.push(connection&&call.connectionName&&!connection.bound?'Unbound connection reference '+(connection.referenceLogicalName??call.connectionName)+' for action '+key+'; bind a local connection or configure an explicit action mock or disable it.':'Unsupported action '+key+' ('+action.type+')'+(routed&&runtime.unsupportedReason?.(call.connectorId,call.operationId)?': '+runtime.unsupportedReason(call.connectorId,call.operationId):'')+'; configure an explicit action mock or disable it.');
  if(override&&!['exported','mock','disabled'].includes(mode))errors.push('Invalid action mode '+key);
  if(action.type==='Response'&&inLoop)errors.push('Response is not allowed within a loop: '+key);
  if(!inheritedSkip&&!['mock','disabled'].includes(mode)){
   if(action.type==='InitializeVariable'&&depth>0)errors.push('InitializeVariable requires the workflow global level: '+key);
   if(action.type==='Response'){const raw=action.inputs?.statusCode??200;if((typeof raw!=='string'||!raw.startsWith('@'))&&!responseStatus(Number(raw)))errors.push('Response requires a 2xx, 4xx or 5xx status code: '+key);}
   for(const setting of ['runtimeConfiguration','retryPolicy','operationOptions','limit','staticResults'])if(own(action,setting)&&!(setting==='runtimeConfiguration'&&(connector&&runtimeConfigurationOk(action.runtimeConfiguration,dataverse)||action.type==='Foreach'&&foreachConcurrencyOk(action.runtimeConfiguration)))&&!(setting==='operationOptions'&&operationOptionsOk(action,connector))&&!(setting==='limit'&&action.type==='Until'))errors.push('Unsupported action setting '+key+'/'+setting+'; configure an explicit mock or disable it.');
   // Mirage determinism policy (Learn logic-apps-control-flow-loops only says such writes "might return unpredictable
   // results"): a Foreach outside any loop runs its repetitions concurrently (frame.loops empty, also inside a Scope, If or
   // Switch), so iterations that write a variable are refused, as concurrent branches that do are.
   if(action.type==='Foreach'&&!inLoop&&(action.runtimeConfiguration?.concurrency?.repetitions??1)>1&&!String(action.operationOptions??'').includes('Sequential')){const written=[];const walk=m=>{for(const[n,a]of Object.entries(m??{})){if(!a||typeof a!=='object'||['mock','disabled'].includes(steps[key+'/'+n]?.mode))continue;if(WRITES.has(a.type)&&typeof a.inputs?.name==='string')written.push(a.inputs.name);walk(a.actions);walk(a.else?.actions);walk(a.default?.actions);for(const c of Object.values(a.cases??{}))walk(c?.actions);}};walk(action.actions);
    if(written.length)errors.push('Foreach '+key+' runs its iterations concurrently and writes the variable '+[...new Set(written)].join(', ')+'; Mirage refuses concurrent variable writes because their result depends on the interleaving: set concurrency to 1 or configure an explicit workflow mock.');}
   // A retry policy applies to provider calls only; on a built-in action or with invalid values it is a bad request.
   if(action.inputs&&typeof action.inputs==='object'&&own(action.inputs,'retryPolicy')){
    if(builtins.has(action.type)){badRequest=true;errors.push('A retry policy is not allowed on built-in action '+key);}
    else if(!connector)errors.push('Unsupported action retry policy '+key);
    else try{parseRetryPolicy(action.inputs.retryPolicy);}catch(error){badRequest=true;errors.push('Invalid retry policy '+key+': '+error.message);}
   }
   if(action.type==='Until'){const limit=action.limit??{};if(typeof action.expression!=='string'&&!(action.expression&&typeof action.expression==='object'))errors.push('Until requires an expression: '+key);if(!limit||typeof limit!=='object'||Array.isArray(limit)||Object.keys(limit).some(k=>!['count','timeout'].includes(k))||limit.count!==undefined&&!(Number.isInteger(limit.count)&&limit.count>=1&&limit.count<=5000)||limit.timeout!==undefined&&durationMs(limit.timeout)===null)errors.push('Until limit takes count (1-5000) and an ISO 8601 timeout: '+key);
    // A count above the local iteration limit would stop early and report Succeeded: refuse it (native maximum 5000).
    else if((limit.count??60)>maxIterations)errors.push('Until '+key+' limit.count '+(limit.count??60)+' exceeds the local iteration limit ('+maxIterations+').');}
   // One parameter table (connector-runtime.mjs DATAVERSE_OPERATION_SPEC) for this allowlist and the provider.
   if(connector&&dataverse){const op=action.inputs.host.operationId,spec=dataverseParameters(op);for(const parameter of Object.keys(action.inputs.parameters??{}))if(!spec?.allowed(parameter))errors.push('Unsupported Dataverse parameter '+key+'/'+parameter);}
   // Perform a changeset request (https://learn.microsoft.com/power-automate/dataverse/change-set): a scope of Add, Update and
   // Delete row actions on one Dataverse connection, without dependencies between them, run as one transaction.
   // unverified: the exported definition shape (type ChangeSet with nested actions).
   if(action.type==='ChangeSet'){const inner=Object.entries(action.actions??{}),names=new Set(inner.map(([,a])=>a?.inputs?.host?.connectionName??null));if(!inner.length)errors.push('A changeset needs at least one action: '+key);if(names.size>1)errors.push('Changeset actions must share one Dataverse connection: '+key);
    for(const[n,a]of inner){const call=connectorCall(a);if(a?.type!=='OpenApiConnection'||call?.connectorId!==DATAVERSE_CONNECTOR||!CHANGESET_OPERATIONS.includes(call.operationId))errors.push('A changeset holds only Dataverse Add, Update, Upsert and Delete row actions: '+key+'/'+n);if(Object.keys(a?.runAfter??{}).length)errors.push('Changeset actions cannot depend on each other: '+key+'/'+n);if(steps[key+'/'+n])errors.push('Changeset actions run together; configure the changeset, not '+key+'/'+n);}}
  }
  if(action.runAfter!=null&&(!action.runAfter||typeof action.runAfter!=='object'||Array.isArray(action.runAfter)))errors.push('Invalid runAfter '+key);
  for(const[dependency,statuses]of Object.entries(action.runAfter??{}))if(!own(map,dependency)||!Array.isArray(statuses)||statuses.length===0||statuses.some(x=>!['Succeeded','Failed','Skipped','TimedOut'].includes(x)))errors.push('Invalid runAfter dependency '+key+'/'+dependency);
  const skipped=inheritedSkip||['disabled','mock'].includes(mode),loop=inLoop||['Foreach','Until'].includes(action.type);if(action.actions)visit(action.actions,key+'/',depth+1,skipped,loop);if(action.else?.actions)visit(action.else.actions,key+'/else/',depth+1,skipped,loop);
  for(const[caseName,branch]of Object.entries(action.cases??{}))visit(branch.actions??{},key+'/case:'+caseName+'/',depth+1,skipped,loop);if(action.default?.actions)visit(action.default.actions,key+'/default/',depth+1,skipped,loop);
 }const visiting=new Set(),visited=new Set();const check=name=>{if(visiting.has(name)){errors.push('Flow runAfter dependency cycle: '+prefix+name);return;}if(visited.has(name))return;visiting.add(name);for(const dep of Object.keys(map[name]?.runAfter??{}))if(own(map,dep))check(dep);visiting.delete(name);visited.add(name);};for(const name of Object.keys(map))check(name);
 const ancestor=(name,target,seen=new Set())=>{if(seen.has(name))return false;seen.add(name);return Object.keys(map[name]?.runAfter??{}).some(dep=>dep===target||own(map,dep)&&ancestor(dep,target,seen));},names=Object.keys(map);
 // Concurrent branches start together (executeFlowDefinition's scheduler); two branches that cannot both run (runAfter
 // statuses of one predecessor that exclude each other) are not concurrent. An outcome that depends on the interleaving
 // needs a mock: two concurrent branches writing the same variable or both answering a Response.
 const lineage=name=>{const all=new Set([name]),walk=n=>{for(const dep of Object.keys(map[n]?.runAfter??{}))if(own(map,dep)&&!all.has(dep)){all.add(dep);walk(dep);}};walk(name);return [...all];};
 const exclusive=(a,b)=>lineage(a).some(x=>lineage(b).some(y=>x!==y&&Object.entries(map[x]?.runAfter??{}).some(([dep,s])=>Array.isArray(s)&&Array.isArray(map[y]?.runAfter?.[dep])&&!s.some(v=>map[y].runAfter[dep].includes(v)))));
 // A branch that reads a variable another concurrent branch writes depends on the interleaving as much as two writers.
 const effects=(action,key,acc={vars:new Set(),reads:new Set(),response:false})=>{if(!action||typeof action!=='object'||['mock','disabled'].includes(steps[key]?.mode))return acc;if(WRITES.has(action.type)&&typeof action.inputs?.name==='string')acc.vars.add(action.inputs.name);if(action.type==='Response')acc.response=true;
  for(const[,name]of JSON.stringify([action.inputs??null,action.expression??null,action.foreach??null]).matchAll(/variables\('([^']+)'\)/g))acc.reads.add(name);
  const nested=[[action.actions,key+'/'],[action.else?.actions,key+'/else/'],[action.default?.actions,key+'/default/'],...Object.entries(action.cases??{}).map(([c,v])=>[v?.actions,key+'/case:'+c+'/'])];for(const[child,at]of nested)for(const[n,a]of Object.entries(child??{}))effects(a,at+n,acc);return acc;};
 for(let a=0;a<names.length;a++)for(let b=a+1;b<names.length;b++)if(!inheritedSkip&&!ancestor(names[a],names[b])&&!ancestor(names[b],names[a])&&!exclusive(names[a],names[b])){
  parallel++;const ea=effects(map[names[a]],prefix+names[a]),eb=effects(map[names[b]],prefix+names[b]),shared=[...ea.vars].filter(v=>eb.vars.has(v)),read=[...ea.vars].filter(v=>eb.reads.has(v)).concat([...eb.vars].filter(v=>ea.reads.has(v)));
  if(shared.length||read.length||ea.response&&eb.response)errors.push('Concurrent action branches '+(shared.length?'write the variable '+shared.join(', '):read.length?'write and read the variable '+[...new Set(read)].join(', '):'both answer a Response')+' and depend on the interleaving; configure an explicit workflow mock: '+prefix+names[a]+' / '+prefix+names[b]);
 }
 };visit(definition?.actions??{});if(count>250)errors.push('Local flow limit is 250 source actions.');
 const triggers=Object.entries(definition?.triggers??{}),triggerCall=triggers.length===1?connectorCall(triggers[0][1]):null;if(triggerCall&&(connectors||triggerCall.connectorId===DATAVERSE_CONNECTOR))bind(triggerCall,'trigger:'+triggers[0][0]);
 for(const key of Object.keys(steps))if(!actions.some(a=>a.key===key))errors.push('Unknown configured action '+key);
 return {supported:errors.length===0,...(badRequest?{badRequest}:{}),...(parallel?{parallel}:{}),actions,connections:[...connections.values()],errors,inputSchema:Object.values(definition?.triggers??{}).find(t=>t.type==='Request')?.inputs?.schema??null};
}
/** Parse WDL expressions without JavaScript evaluation or ambient process access. */
export function parseFlowExpression(source){
 let i=0,depth=0;const ws=()=>{while(/\s/.test(source[i]??'')&&i<source.length)i++;};
 const parse=()=>{if(++depth>64)fail('Flow expression nesting exceeds 64.');ws();let node;
  if(source[i]==="'"){i++;let value='';for(;;){if(i>=source.length)fail('Unterminated flow expression string.');if(source[i]==="'"){i++;if(source[i]==="'"){value+="'";i++;continue;}break;}value+=source[i++];}node={kind:'literal',value};}
  else{const token=/^(?:-?\d+(?:\.\d+)?|[a-zA-Z_][\w]*)/.exec(source.slice(i));if(!token)fail('Unsupported flow expression syntax.');i+=token[0].length;ws();if(source[i]==='('){i++;const args=[];ws();while(source[i]!==')'){args.push(parse());ws();if(source[i]===','){i++;continue;}if(source[i]!==')')fail('Flow expression argument separator is missing.');}i++;node={kind:'call',name:token[0],args};}else if(/^-?\d/.test(token[0]))node={kind:'literal',value:token[0].includes('.')?Number(token[0]):exactNumeric(token[0],'Int64'),numericType:token[0].includes('.')?'float':'integer'};else if(['true','false','null'].includes(token[0]))node={kind:'literal',value:JSON.parse(token[0])};else fail('Unsupported bare flow expression identifier.');}
  for(;;){ws();let optional=false;if(source[i]==='?'){optional=true;i++;}if(source[i]==='['){i++;const key=parse();ws();if(source[i++]!==']')fail('Flow property bracket is missing.');node={kind:'property',object:node,key,optional};}else if(source[i]==='.'){i++;const key=/^[\w]+/.exec(source.slice(i));if(!key)fail('Flow property name is missing.');i+=key[0].length;node={kind:'property',object:node,key:{kind:'literal',value:key[0]},optional};}else{if(optional)fail('Optional property operator needs a property.');break;}}
  depth--;return node;
 };const result=parse();ws();if(i!==source.length)fail('Unsupported trailing flow expression syntax.');return result;
}
function evaluate(node,state){
 if(node.kind==='literal')return node.value;
 if(node.kind==='property'){let object=evaluate(node.object,state);const key=evaluate(node.key,state),parts=typeof key==='string'&&!own(object,key)?key.split('/'):[key];for(const part of parts){if(unsafe(String(part)))fail('Unsafe flow property.');if(object==null||!own(object,part)){if(node.optional)return null;fail('Flow expression property is absent.',400,'LocalFlowExpression');}object=object[part];}return object;}
 const n=node.name.toLowerCase(),a=node.args.map(arg=>evaluate(arg,state));
 const arity=(min,max=min)=>{if(a.length<min||a.length>max)fail('Invalid argument count for '+node.name);};
 const numeric=()=>{if(a.some(v=>!isExactNumeric(v)&&(typeof v!=='number'||!Number.isFinite(v))))fail('Numeric arguments required for '+node.name,400,'LocalFlowExpression');};
 switch(n){
  case 'triggerbody':arity(0);return state.input;
  case 'triggeroutputs':arity(0);return {body:state.input};
  case 'variables':arity(1);if(!own(state.variables,a[0]))fail('Unknown flow variable.',400,'LocalFlowExpression');return state.variables[a[0]].value;
  case 'parameters':arity(1);if(!own(state.parameters,a[0]))fail('Unknown flow parameter.',400,'LocalFlowExpression');return state.parameters[a[0]];
  case 'body':case 'outputs':case 'actions':arity(1);if(!hasResult(state.results,a[0]))fail('Action output is unavailable.',400,'LocalFlowExpression');return n==='body'?state.results[a[0]].outputs?.body??null:n==='outputs'?state.results[a[0]].outputs:state.results[a[0]];
  case 'item':arity(0);if(!state.items.length)fail('item() requires a foreach context.');return state.items.at(-1).value;
  case 'items':arity(1);{const item=state.items.findLast(x=>x.name===a[0]);if(!item)fail('Unknown foreach context.');return item.value;}
  case 'concat':arity(2,1000);return a.map(v=>isExactNumeric(v)?v.value:typeof v==='string'?v:stringifyExactJson(v)).join('');
  case 'equals':arity(2);return equivalent(a[0],a[1]);
  case 'and':case 'or':arity(2,1000);if(a.some(v=>typeof v!=='boolean'))fail('Boolean arguments required.');return n==='and'?a.every(v=>v):a.some(v=>v);
  case 'not':arity(1);if(typeof a[0]!=='boolean')fail('not() requires a boolean.');return !a[0];
  case 'coalesce':return a.find(v=>v!==null&&v!==undefined)??null;
  case 'if':arity(3);if(typeof a[0]!=='boolean')fail('if() requires a boolean.');return a[0]?a[1]:a[2];
  case 'add':case 'sub':case 'mul':case 'div':case 'mod':arity(2);numeric();if(['div','mod'].includes(n)&&compareNumeric(a[1],0)===0)fail('Division by zero.',400,'LocalFlowExpression');if(a.some(isExactNumeric)){const integer=node.args.every(arg=>numericKind(arg,state)==='integer'),type=integer?'Int64':'Decimal';return n==='add'?sumNumeric(a,type):n==='sub'?sumNumeric([a[0],multiplyNumeric([a[1],-1])],type):n==='mul'?multiplyNumeric(a,type):divideNumeric(a[0],a[1],{integer,modulo:n==='mod'});};return n==='add'?a[0]+a[1]:n==='sub'?a[0]-a[1]:n==='mul'?a[0]*a[1]:n==='div'?(node.args.every(arg=>numericKind(arg,state)==='integer')?Math.trunc(a[0]/a[1]):a[0]/a[1]):a[0]%a[1];
  case 'greater':case 'greaterorequals':case 'less':case 'lessorequals':arity(2);numeric();{const compared=compareNumeric(a[0],a[1]);return n==='greater'?compared>0:n==='greaterorequals'?compared>=0:n==='less'?compared<0:compared<=0;}
  case 'string':arity(1);return a[0]==null?'':isExactNumeric(a[0])?a[0].value:typeof a[0]==='string'?a[0]:stringifyExactJson(a[0]);
  case 'int':case 'float':arity(1);{const raw=isExactNumeric(a[0])?a[0].value:a[0];if(typeof raw!=='string'&&typeof raw!=='number'||typeof raw==='string'&&(!raw.trim()||n==='int'&&!/^[-+]?\d+$/.test(raw)))fail('Invalid numeric conversion.',400,'LocalFlowExpression');if(n==='int'){const exact=exactNumeric(typeof raw==='string'?raw.trim():raw,'Int64');if(decimalParts(exact).scale||compareNumeric(exact,'-9223372036854775808')<0||compareNumeric(exact,'9223372036854775807')>0)fail('Integer conversion exceeds Int64.',400,'LocalFlowExpression');return exact;}const value=Number(raw);if(!Number.isFinite(value))fail('Invalid numeric conversion.',400,'LocalFlowExpression');return value;}
  case 'json':arity(1);try{return parseExactJson(a[0]);}catch{fail('Invalid JSON expression value.',400,'LocalFlowExpression');}
  case 'length':arity(1);if(typeof a[0]!=='string'&&!Array.isArray(a[0]))fail('length() requires a string or array.');return a[0].length;
  case 'empty':arity(1);return a[0]==null||a[0]===''||Array.isArray(a[0])&&a[0].length===0||typeof a[0]==='object'&&Object.keys(a[0]).length===0;
  // An array contains a value equal to it (exact numerics by value, objects member-wise), a string a substring, an object a key.
  case 'contains':arity(2);return typeof a[0]==='string'?a[0].includes(a[1]):Array.isArray(a[0])?a[0].some(v=>equivalent(v,a[1])):a[0]&&typeof a[0]==='object'&&!isExactNumeric(a[0])?own(a[0],a[1]):fail('contains() requires a collection.');
  case 'createarray':return a;
  case 'first':case 'last':arity(1);return n==='first'?a[0]?.[0]??null:a[0]?.at(-1)??null;
  case 'tolower':case 'toupper':case 'trim':arity(1);if(typeof a[0]!=='string')fail('String argument required.');return n==='tolower'?a[0].toLowerCase():n==='toupper'?a[0].toUpperCase():a[0].trim();
  case 'replace':arity(3);if(a.some(v=>typeof v!=='string'))fail('replace() requires strings.');return a[0].replaceAll(a[1],a[2]);
  default:fail('Unsupported local flow function: '+node.name);
 }
}
export function resolveFlowValue(value,state){
 if(Array.isArray(value))return value.map(v=>resolveFlowValue(v,state));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>{if(unsafe(k))fail('Unsafe flow input key.');return [k,resolveFlowValue(v,state)];}));
 if(typeof value!=='string'||!value.startsWith('@')&&!value.includes('@{'))return value;
 if(value.startsWith('@@'))return value.slice(1);
 if(value.startsWith('@')&&!value.startsWith('@{'))return evaluate(parseFlowExpression(value.slice(1)),state);
 let result='',cursor=0;
 while(cursor<value.length){
  const start=value.indexOf('@{',cursor);if(start<0){result+=value.slice(cursor);break;}
  const escaped=start>cursor&&value[start-1]==='@';let end=start+2,quoted=false;
  for(;end<value.length;end++){if(value[end]==="'"){if(quoted&&value[end+1]==="'"){end++;continue;}quoted=!quoted;}if(value[end]==='}'&&!quoted)break;}
  if(escaped){result+=value.slice(cursor,start-1)+value.slice(start,end+1);cursor=end+1;continue;}
  if(end===value.length)fail('Unterminated interpolated flow expression.');
  result+=value.slice(cursor,start);const answer=evaluate(parseFlowExpression(value.slice(start+2,end)),state);
  result+=typeof answer==='string'?answer:answer==null?'':stringifyExactJson(answer);cursor=end+1;
 }
 return result;
}
export function validateFlowInput(value,schema={},name='body',depth=0){
 if(depth>32)fail('The cloud-flow input schema exceeds the local nesting limit.');const invalid=message=>fail(`Cloud-flow input ${name} ${message}.`,400,'InvalidRequest');
 const matches=t=>t==='null'?value===null:t==='array'?Array.isArray(value):t==='object'?Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&!isExactNumeric(value)):t==='integer'?Number.isInteger(value)||isExactNumeric(value)&&decimalParts(value).scale===0:t==='number'?typeof value==='number'&&Number.isFinite(value)||isExactNumeric(value):typeof value===t;
 if(schema.type&&![schema.type].flat().some(matches))invalid('has an invalid type');if(schema.enum&&!schema.enum.some(v=>equivalent(v,value)))invalid('is not an allowed value');
 if(value&&typeof value==='object'&&!Array.isArray(value)){for(const key of schema.required??[])if(!own(value,key))invalid('is missing required property '+key);for(const[k,v]of Object.entries(value)){if(schema.properties?.[k])validateFlowInput(v,schema.properties[k],name+'.'+k,depth+1);else if(schema.additionalProperties===false)invalid('contains undeclared property '+k);}}
 if(Array.isArray(value)&&schema.items)value.forEach((v,i)=>validateFlowInput(v,schema.items,name+'['+i+']',depth+1));
}
// A skipped leaf inherits its predecessor's completion status. A successful
// error handler therefore resolves the failed branch without rewriting history.
function failedCompletion(map,results){
 const predecessors=new Set(Object.values(map??{}).flatMap(action=>Object.keys(action.runAfter??{})));
 const failed=(name,seen=new Set())=>{if(seen.has(name))return false;seen.add(name);const status=results[name]?.status;if(status==='Succeeded')return false;if(['Failed','TimedOut'].includes(status))return true;return Object.keys(map[name]?.runAfter??{}).some(dep=>failed(dep,new Set(seen)));};
 return Object.keys(map??{}).filter(name=>!predecessors.has(name)).some(name=>failed(name));
}
// Runs a generator that yields connector calls: synchronous while every answer is synchronous, a Promise after the first async one.
function drive(iterator,answer){
 const step=(method,arg)=>{for(;;){const next=iterator[method](arg);if(next.done)return next.value;let value;try{value=answer(next.value);}catch(error){method='throw';arg=error;continue;}if(typeof value?.then==='function')return value.then(v=>step('next',v),e=>step('throw',e));method='next';arg=value;}};
 return step('next');
}
// A parameter value from an environment variable's text, typed by the flow parameter's declared type.
function typedParameter(text,type){
 const kind=String(type??'').toLowerCase();
 if(['int','integer','float','number'].includes(kind)){const value=Number(text);return text.trim()!==''&&Number.isFinite(value)?value:text;}
 if(['bool','boolean'].includes(kind))return /^true$/i.test(text)?true:/^false$/i.test(text)?false:text;
 if(['object','array'].includes(kind)){try{return parseExactJson(text);}catch{return text;}}
 return text;
}
/** Flow parameters (02-B7): one bound to an environment variable (metadata.schemaName) takes its effective value (Solution value
 * plus profile, project and _sim overrides) over the exported defaultValue; Secret ones are listed for the resolver, never read here. */
function flowParameters(definition,store){
 const effective=store?.state?effectiveEnvironmentVariables(store.state):{},values={},secrets=[];
 for(const[name,spec]of Object.entries(definition?.parameters??{})){
  if(unsafe(name))continue;
  const schema=spec?.metadata?.schemaName,entry=schema?effective[String(schema).toLowerCase()]:null;
  if(entry?.secret){secrets.push([name,entry.reference]);continue;}
  if(entry&&entry.value!==null)values[name]=typedParameter(entry.value,spec.type);
  else if(own(spec,'defaultValue'))values[name]=spec.defaultValue;
 }
 return {values,secrets};
}
/** Executes imported definitions only. External actions never become successful implicit no-ops.
 * Connector actions go through `connectors` (createConnectorRuntime); without it only built-in Dataverse actions run.
 * Returns the result synchronously while every provider answers synchronously, otherwise a Promise: always await it.
 * With context.runId (a tracked run, runTrackedFlow) a waiting action (an approval, a Wait delay) answers
 * { status: 'Waiting', suspended: { actionPath, wait }, actions, response? }; journal(actionPath, { status, outputs, secure,
 * attempts? }) receives every executed connector action (secure: outputs under secureData or inputs naming a Secret parameter).
 * context.signal (an AbortSignal) cancels the run: no action is scheduled after it aborts, provider calls receive it, and the
 * run answers { status: 'Cancelled', actions } (or throws FlowRunCancelled when its trigger expects a Response it never sent).
 * onOutcome({ status, error? }) receives the run outcome when a Response answered the caller: the Response is the caller's
 * answer, the outcome is the run's (a later failed action fails the run although the caller got its Response). */
export function executeFlowDefinition({definition,input,store,serviceProfile,steps={},diagnostic=()=>{},limits={},connectors,connectionReferences,context={},secrets=context?.secrets??null,journal=null,parameters:frozen=null,onOutcome=null}){
 const contract=inspectFlowDefinition(definition,steps,{connectors,connectionReferences,principal:serviceProfile,maxIterations:Math.min(limits.maxIterations??100,1000)}),trigger=inspectFlowTrigger(definition,{connectors});if(!contract.supported)fail(contract.errors.join(' '),contract.badRequest?400:501,contract.badRequest?'InvalidRequest':'LocalFlowUnsupported');if(!trigger.supported)fail(trigger.errors.join(' '));const triggers=Object.values(definition?.triggers??{});if(!input||typeof input!=='object'||Array.isArray(input))fail('The cloud-flow input must be an object.',400,'InvalidRequest');validateFlowInput(input,triggers[0].inputs?.schema);
 // A tracked run passes the non-secret parameter values frozen at its start (runTrackedFlow), so a resume replays them.
 const parameters=flowParameters(definition,store),state={input,variables:{},parameters:frozen?clone(frozen):parameters.values,results:Object.create(null),items:[]};if(serviceProfile)validateServiceProfile(serviceProfile);const runtime=connectors??createConnectorRuntime({store}),correlationId=context.correlationId??randomUUID();let budget=0,response,terminated=false,terminatedFailure=null,terminatedCancelled=false,cancelled=false;
 // Journalled action paths a resume replays as mocks; a live provider call while one is unconsumed means the replay diverged.
 // context.journal: the journalled outcomes a resume replays, keyed by action path plus the loop iteration ('path', 'path#2' for a
 // loop body's second iteration, 'path#1.3' inside nested loops), so an action inside a loop replays each iteration's answer.
 const unconsumed=new Set(context.replay??[]),replayed=context.journal??{};let suspension=null;const maxActions=Math.min(limits.maxActions??2000,10000),maxIterations=Math.min(limits.maxIterations??100,1000),deadline=Date.now()+Math.min(limits.timeoutMs??2000,5000);
 const signal=context.signal??null,stopped=()=>terminated||cancelled||(signal?.aborted?(cancelled=true):false);
 // Every frame (the run, a Scope or condition branch, a loop iteration) has its foreach items and loop indexes; an iteration
 // has its own action results layered over its parent's. A waiting action suspends anywhere in a tracked run: its journal key
 // names the iteration, so the resume replays the earlier iterations and continues at the waiting one.
 const root={items:[],loops:[],results:state.results},scope=frame=>frame===root?state:{...state,items:frame.items,results:frame.results};
 const atOf=(key,frame)=>frame.loops.some(i=>i>0)?key+'#'+frame.loops.map(i=>i+1).join('.'):key;
 const canSuspend=()=>Boolean(context.runId),attempts=new Map();
 // Secure outputs (runtimeConfiguration.secureData outputs) are sealed in the journal (flow-runs.mjs); an action that only takes a Secret
 // parameter as input journals its outputs (inputs are never journalled), so its run resumes.
 const secure=action=>Boolean(action.runtimeConfiguration?.secureData?.properties?.includes('outputs'));
 // An action that may call a provider or wait. Once a branch is suspended these are deferred to the resume, so no provider
 // call (an approval) is made twice; built-in actions of other branches keep running (a Response answers before the run waits).
 const mayWait=action=>Boolean(connectorCall(action))||['Wait','ChangeSet'].includes(action.type)||own(packActions,action.type);
 const delay=inputs=>{const at=Number(store?.clock?.now?.()??Date.now()),until=inputs?.until?.timestamp,count=inputs?.interval?.count,unit=UNIT_MS[inputs?.interval?.unit];
  const due=until!=null?Date.parse(until):Number.isFinite(Number(count))&&Number(count)>=0&&unit?at+Number(count)*unit:NaN;if(!Number.isFinite(due))fail('A Wait action needs interval { count, unit: Second|Minute|Hour|Day|Week } or until.timestamp.',400,'LocalFlowExpression');
  return {kind:'delay',id:store?.ids?.uuid?.()??randomUUID(),until:new Date(due).toISOString()};};
 const packActions=runtime.flowActions?.()??{};
 const dataContext=(name,frame)=>{const sc=scope(frame);return {resolve:v=>resolveFlowValue(v,sc),maxIterations,validate:validateFlowInput,each:(values,fn)=>values.map(value=>{sc.items.push({name,value});try{return fn(value);}finally{sc.items.pop();}})};};
 const trace=(key,action,status,error)=>diagnostic({code:'FLOW_ACTION',action:key,type:action.type,mode:steps[key]?.mode??'exported',status,...(error?{error:{code:error.code??'LocalFlowError',message:error.message}}:{})});
 const variable=(name,value)=>{const v=state.variables[name];if(!v)fail('Unknown flow variable.',400,'LocalFlowExpression');validateFlowInput(value,{type:{integer:'integer',float:'number',boolean:'boolean',string:'string',array:'array',object:'object'}[v.type]},name);v.value=clone(value);};
 const condition=(value,sc)=>{if(typeof value==='string')return resolveFlowValue(value,sc);if(!value||typeof value!=='object'||Object.keys(value).length!==1)fail('Unsupported flow condition.');const[fn,args]=Object.entries(value)[0];return evaluate({kind:'call',name:fn,args:[args].flat().map(v=>({kind:'literal',value:typeof v==='object'&&!Array.isArray(v)?condition(v,sc):resolveFlowValue(v,sc)}))},sc);};
 // An action result is recorded in its frame and, for the run's actions output, in the run's results (the last iteration's).
 const record=(frame,name,result,local)=>{if(local)local[name]=result;frame.results[name]=result;if(frame.results!==state.results)state.results[name]=result;};
 const skip=(map,prefix,frame)=>{for(const[name,action]of Object.entries(map??{})){record(frame,name,{status:'Skipped',outputs:{}});trace(prefix+name,action,'Skipped');skip(action.actions,prefix+name+'/',frame);skip(action.else?.actions,prefix+name+'/else/',frame);for(const[branch,c]of Object.entries(action.cases??{}))skip(c.actions,prefix+name+'/case:'+branch+'/',frame);skip(action.default?.actions,prefix+name+'/default/',frame);}};
 // Runs a set of generators (loop iterations) with at most `degree` in flight; answers false when one failed. After a
 // suspension no further iteration starts (the resume continues there); errors other than a suspension stop the run.
 const each=function*(count,degree,body){let ok=true,next=0,first=null;const inflight=new Set(),settle=r=>{if(r===false)ok=false;};
  while((next<count||inflight.size)&&!stopped()){
   while(next<count&&inflight.size<degree&&!first&&!stopped()){const i=next++;let r;
    try{r=drive(body(i),call);}catch(cause){if(cause instanceof FlowSuspended){first??=cause;continue;}throw cause;}
    if(typeof r?.then==='function'){const p=r.then(settle,cause=>{if(cause instanceof FlowSuspended)first??=cause;else throw cause;}).finally(()=>inflight.delete(p));p.catch(()=>{});inflight.add(p);}else settle(r);}
   if(inflight.size)yield {wait:Promise.race(inflight)};else if(first)break;
  }
  if(inflight.size)yield {wait:Promise.all(inflight)};
  if(first)throw first;return ok;};
 // One action of a frame (one place for both scheduler rules below): runAfter statuses, deferral after a suspension, the
 // action itself and its recorded result and journal entry.
 const step=function*(name,map,prefix,frame,ctl){
  const action=map[name],key=prefix+name,sc=scope(frame),resolve=v=>resolveFlowValue(v,sc);if(++budget>maxActions||Date.now()>deadline)fail('Local flow execution limit exceeded.',504,'LocalFlowTimeout');
  const statuses=action.runAfter??{};if(Object.entries(statuses).some(([dep,allowed])=>!allowed.includes(ctl.local[dep]?.status))){record(frame,name,{status:'Skipped',outputs:{}},ctl.local);trace(key,action,'Skipped');skip(action.actions,key+'/',frame);skip(action.else?.actions,key+'/else/',frame);for(const[branch,c]of Object.entries(action.cases??{}))skip(c.actions,key+'/case:'+branch+'/',frame);skip(action.default?.actions,key+'/default/',frame);return;}
  if(suspension&&mayWait(action)){ctl.held.add(name);return;}
  const at=atOf(key,frame);
  const override=own(replayed,at)?{mode:'mock',status:replayed[at].status,outputs:replayed[at].outputs}:steps[key];let outputs={},status='Succeeded',error,called=false;
  // One failure rule for every provider-backed action (connector, Http, child flow, pack action): an answer of 400 or above
  // fails the action with ActionFailed and keeps { statusCode, headers, body } as its outputs. Thrown provider errors and an
  // exhausted retry fail it too (catch below). unverified: a child flow Response of 4xx/5xx failing the parent action is
  // inferred from the documented ActionFailed causes (https://learn.microsoft.com/power-automate/error-reference).
  const failedAnswer=()=>{if(Number.isInteger(outputs?.statusCode)&&outputs.statusCode>=400){status='Failed';error={code:'ActionFailed',message:'The action answered status '+outputs.statusCode+'.'};}};
  const iteration=(i,value)=>({items:value===undefined?frame.items:[...frame.items,{name,value}],loops:[...frame.loops,i],results:Object.create(frame.results)});
  try{
   if(override?.mode==='disabled'){status='Skipped';}
   else if(override?.mode==='mock'){unconsumed.delete(at);status=override.status??'Succeeded';if(!['Succeeded','Failed','Skipped','TimedOut'].includes(status))fail('Invalid mock action status.');outputs=clone(override.outputs??{});}
   else switch(action.type){
    case 'Compose':outputs=resolve(action.inputs);break;
    case 'InitializeVariable':for(const v of action.inputs?.variables??[]){if(unsafe(v.name)||own(state.variables,v.name))fail('Duplicate or unsafe variable.');if(!['integer','float','boolean','string','array','object'].includes(v.type))fail('Unsupported variable type.');state.variables[v.name]={type:v.type,value:null};variable(v.name,resolve(v.value));}break;
    case 'SetVariable':variable(action.inputs.name,resolve(action.inputs.value));break;
    case 'IncrementVariable':case 'DecrementVariable':{const name=action.inputs.name,prior=state.variables[name]?.value,delta=resolve(action.inputs.value??1);if(!isExactNumeric(prior)&&typeof prior!=='number'||!isExactNumeric(delta)&&typeof delta!=='number')fail('Numeric variable required.');variable(name,isExactNumeric(prior)||isExactNumeric(delta)?sumNumeric([prior,action.type==='IncrementVariable'?delta:multiplyNumeric([delta,-1])],state.variables[name].type==='integer'?'Int64':'Decimal'):prior+(action.type==='IncrementVariable'?delta:-delta));break;}
    case 'AppendToArrayVariable':{const name=action.inputs.name,prior=state.variables[name]?.value;if(!Array.isArray(prior))fail('Array variable required.');variable(name,[...prior,resolve(action.inputs.value)]);break;}
    case 'AppendToStringVariable':{const name=action.inputs.name,prior=state.variables[name]?.value,value=resolve(action.inputs.value);if(typeof prior!=='string'||typeof value!=='string')fail('String variable required.');variable(name,prior+value);break;}
    case 'If':{const test=condition(action.expression,sc);if(typeof test!=='boolean')fail('Flow condition must be boolean.');skip(test?action.else?.actions:action.actions,key+(test?'/else/':'/'),frame);if(!(yield* run(test?action.actions:action.else?.actions,key+(test?'/':'/else/'),frame)))status='Failed';break;}
    case 'Scope':if(!(yield* run(action.actions,key+'/',frame)))status='Failed';break;
    // Iterations run in order by default (Power Automate: "Apply to each loops execute sequentially by default"); a Foreach
    // outside any loop (also inside a Scope, If or Switch) with concurrency.repetitions runs that many at once, one nested in a
    // loop always in sequence
    // (https://learn.microsoft.com/power-automate/guidance/coding-guidelines/implement-parallel-execution#control-concurrency).
    case 'Foreach':{const values=resolve(action.foreach);if(!Array.isArray(values)||values.length>maxIterations)fail('Foreach requires an array within the iteration limit.');
     const degree=frame.loops.length||String(action.operationOptions??'').includes('Sequential')?1:action.runtimeConfiguration?.concurrency?.repetitions??1;
     if(!(yield* each(values.length,degree,i=>run(action.actions,key+'/',iteration(i,values[i])))))status='Failed';break;}
    case 'Switch':{const value=resolve(action.expression),entry=Object.entries(action.cases??{}).find(([,c])=>equivalent(c.case,value));for(const[branch,c]of Object.entries(action.cases??{}))if(branch!==entry?.[0])skip(c.actions,key+'/case:'+branch+'/',frame);if(entry)skip(action.default?.actions,key+'/default/',frame);if(!(yield* run(entry?entry[1].actions:action.default?.actions,key+(entry?'/case:'+entry[0]+'/':'/default/'),frame)))status='Failed';break;}
    case 'Response':{const answer=resolve(action.inputs??{}),code=Number(answer.statusCode??200);if(!responseStatus(code)||response)fail('Invalid or duplicate flow response.');const body=own(answer,'body')?answer.body:{},headers=answer.headers;if(headers!==undefined&&(!headers||typeof headers!=='object'||Array.isArray(headers)||Object.entries(headers).some(([k,v])=>!/^[!#$%&'*+.^_`|~\w-]+$/.test(k)||typeof v!=='string'||/[\r\n]/.test(v))))fail('Invalid flow Response headers.');response={status:code,body,...(headers?{headers}:{})};outputs={statusCode:code,body,...(headers?{headers}:{})};break;}
    // Terminate stops the run with runStatus Succeeded, Failed (its runError message) or Cancelled
    // (https://learn.microsoft.com/azure/logic-apps/logic-apps-workflow-actions-triggers#terminate-action).
    case 'Terminate':{const answer=resolve(action.inputs??{});if(!['Succeeded','Failed','Cancelled'].includes(answer.runStatus))fail('Terminate runStatus must be Succeeded, Failed or Cancelled.',400,'LocalFlowExpression');terminated=true;if(answer.runStatus==='Cancelled')terminatedCancelled=true;else if(answer.runStatus==='Failed'){terminatedFailure=new DataError(answer.runError?.message??'Flow terminated with failure.',400,'LocalFlowTerminated');throw terminatedFailure;}break;}
    case 'OpenApiConnection':case 'OpenApiConnectionWebhook':case 'Http':case 'Workflow':{const inputs=resolve(action.inputs);called=true;const answer=yield {action,key,at,inputs};if(answer?.suspended)throw new FlowSuspended(at,{...answer.suspended,...(secure(action)?{secure:true}:{})});outputs=answer;failedAnswer();break;}
    case 'ChangeSet':{const requests=Object.entries(action.actions??{}).map(([n,a])=>({name:n,operationId:a.inputs.host.operationId,parameters:resolve(a.inputs.parameters??{})}));called=true;
     outputs=yield {action:Object.values(action.actions)[0],key,at,inputs:{parameters:{requests}},operationId:'ExecuteChangeset'};failedAnswer();break;}
    case 'Until':{const limit=action.limit??{},count=limit.count??60,timeout=durationMs(limit.timeout??'PT1H'),started=Date.now();let met=false;
     // unverified: reaching limit.count without the expression ends the loop Succeeded (the native default); the timeout ends it TimedOut.
     for(let i=0;i<count&&!stopped();i++){const f=iteration(i);if(!(yield* run(action.actions,key+'/',f)))status='Failed';if(stopped())break;const test=condition(action.expression,scope(f));if(typeof test!=='boolean')fail('Until expression must be boolean.');if(test){met=true;break;}if(Date.now()-started>=timeout){status='TimedOut';break;}}
     outputs={conditionMet:met};break;}
    case 'Wait':{const wait=delay(resolve(action.inputs));if(!canSuspend())fail('A Wait action needs a flow run that can suspend; mock or disable this action.',501,'FlowSuspendNotWired');throw new FlowSuspended(at,wait);}
    default:
     if(own(FLOW_ACTIONS,action.type)){outputs=FLOW_ACTIONS[action.type](action,dataContext(name,frame));break;}
     if(own(packActions,action.type)){const inputs=resolve(action.inputs??{});called=true;outputs=yield {packAction:packActions[action.type],request:{type:action.type,inputs},key};if(!outputs||typeof outputs!=='object'||Array.isArray(outputs))fail('The pack flow action returned no outputs object.',502,'ProviderFailed');failedAnswer();break;}
     fail('Unsupported action '+key);
   }
  }catch(cause){if(cause instanceof FlowSuspended){suspension??=cause;ctl.held.add(name);return;}if(cause?.code==='NotResumable')throw cause;
   // An action whose provider call the run's cancellation aborted is Cancelled, not Failed.
   error=cause;status=signal?.aborted&&called?'Cancelled':cause.status===504?'TimedOut':'Failed';outputs={error:{code:cause.code??'LocalFlowError',message:cause.message}};}
  record(frame,name,{status,outputs,...(error?.code==='ActionFailed'?{error:{code:error.code,message:error.message}}:called&&error?{error:{code:'ActionFailed',message:error.message,cause:{code:error.code??'LocalFlowError'}}}:{})},ctl.local);trace(key,action,status,error);
  // A changeset's actions share its outcome: each answers its own response, or all fail when it rolled back.
  // unverified: the native status and error of the actions of a rolled-back changeset.
  if(action.type==='ChangeSet')for(const[n,a]of Object.entries(action.actions??{})){const answer=status==='Succeeded'?(outputs?.body?.responses??[]).find(r=>r.name===n):null;
   record(frame,n,answer?{status:'Succeeded',outputs:{statusCode:answer.statusCode,body:answer.body}}:{status:status==='Skipped'?'Skipped':'Failed',outputs:{error:{code:'ChangeSetRolledBack',message:'The changeset did not commit.'}}});trace(key+'/'+n,a,frame.results[n].status);}
  if(called&&journal&&status!=='Cancelled')journal(at,{status,outputs:clone(outputs),secure:secure(action),...(attempts.has(at)?{attempts:attempts.get(at)}:{})});attempts.delete(at);
  if(Buffer.byteLength(JSON.stringify(state))>4*1024*1024)fail('Local flow state exceeds 4 MiB.',413,'LocalFlowLimit');
 };
 // The branch scheduler. Every action whose runAfter dependencies have all settled starts at once (concurrent branches run
 // together; a provider call that answers asynchronously leaves its sibling branches running) and a join waits for every
 // dependency, then applies its runAfter status sets (Succeeded, Failed, Skipped, TimedOut:
 // https://learn.microsoft.com/azure/logic-apps/error-exception-handling#manage-the-run-after-behavior). Terminate and a
 // cancellation stop the scheduling at once: nothing after them starts
 // (https://learn.microsoft.com/azure/logic-apps/logic-apps-workflow-actions-triggers#terminate-action). A suspended action
 // (Wait, approval, waiting child flow) holds only its own branch: the other ready branches keep running, and the run waits
 // when no branch can progress, so a concurrent Response answers first, as a Wait never blocks a sibling branch natively
 // (https://learn.microsoft.com/power-automate/guidance/coding-guidelines/implement-parallel-execution).
 // While a resume still has journalled outcomes to replay, a live provider call waits for the replayed ones to run first.
 const run=function*(map,prefix='',frame=root){const pending=new Set(Object.keys(map??{})),held=new Set(),local={},inflight=new Map(),ctl={held,local};
  const settled=dep=>!pending.has(dep)&&!held.has(dep)&&!inflight.has(dep);
  while((pending.size||inflight.size)&&!stopped()){
   const ready=[...pending].filter(name=>Object.keys(map[name].runAfter??{}).every(settled));
   let start=unconsumed.size?ready.filter(name=>!mayWait(map[name])||own(replayed,atOf(prefix+name,frame))):ready;
   if(!start.length&&!inflight.size)start=ready;
   for(const name of start){if(stopped())break;pending.delete(name);const done=drive(step(name,map,prefix,frame,ctl),call);
    if(typeof done?.then==='function'){const p=done.then(()=>{inflight.delete(name);},cause=>{inflight.delete(name);throw cause;});p.catch(()=>{});inflight.set(name,p);}}
   if(start.length)continue;
   if(inflight.size){yield {wait:Promise.race(inflight.values())};continue;}
   if(held.size)break;
   fail('Flow runAfter dependency cycle.');
  }
  if(inflight.size)yield {wait:Promise.all(inflight.values())};
  if(held.size&&!terminated&&!cancelled)throw suspension;return !failedCompletion(map,local);};
 // Secret parameters resolve as the flow's principal (secret-resolver.mjs); the value stays in state, never in diagnostics.
 const resolveSecret=({secret,name})=>secrets?secrets.resolve(secret,{principalId:serviceProfile?.userId??context.initiatingUserId??null,purpose:'flow-parameter:'+name}):{status:'unbound'};
 const diverged=key=>{throw new DataError('The flow run cannot resume: ReplayDiverged (action '+key+' would call its provider while journalled actions '+[...unconsumed].join(', ')+' are unreplayed).',409,'NotResumable');};
 const call=request=>{if(own(request,'wait'))return request.wait;if(own(request,'secret'))return resolveSecret(request);if(unconsumed.size)diverged(request.key);
  if(own(request,'packAction'))return request.packAction(structuredClone(request.request),{caller:'flow',initiatingUserId:context.initiatingUserId??null,correlationId,runId:context.runId??null,actionPath:request.key,principal:serviceProfile??null,timeoutMs:Math.max(1,deadline-Date.now()),...(signal?{signal}:{})});
  const{action,key,at,inputs}=request;const target={...connectorCall(action),...(request.operationId?{operationId:request.operationId}:{})},connection=runtime.resolve({...target,connectionReferences,principal:serviceProfile}),minimum=action.runtimeConfiguration?.paginationPolicy?.minimumItemCount;
  const {retryPolicy,...rest}=inputs??{},retry=retryPolicy===undefined?null:parseRetryPolicy(retryPolicy);
  const parameters=action.type==='Http'?rest:action.type==='Workflow'?{workflowReferenceName:rest.host?.workflowReferenceName??null,body:rest.body??{}}:rest.parameters??{};
  return runtime.invoke({connectorId:target.connectorId,operationId:target.operationId,parameters,connection,...(minimum?{pagination:{minimumItemCount:minimum}}:{}),...(retry?{retry}:{}),context:{caller:'flow',initiatingUserId:context.initiatingUserId??null,correlationId,runId:context.runId??null,actionPath:at,timeoutMs:Math.max(1,deadline-Date.now()),
   ...(signal?{signal}:{}),...(String(action.operationOptions??'').includes('DisableAsyncPattern')?{asyncPattern:false}:{}),
   canSuspend:canSuspend(),...(context.waitTimeoutMs?{waitTimeoutMs:context.waitTimeoutMs}:{}),...(context.runChildFlow?{runChildFlow:(target,body)=>context.runChildFlow(target,body,{canSuspend:canSuspend()})}:{}),...(retry?{onAttempt:attempt=>{const list=attempts.get(at)??[];list.push(attempt);attempts.set(at,list);}}:{})}});};
 // A row, recurrence, connector or on-demand (context.background) run completes without a Response; any other run must answer one.
 const rowLike=['dataverse','dataverse-action','recurrence','connector'].includes(trigger.kind),answersWithout=rowLike||context.background||trigger.kind==='http';
 return drive((function*(){for(const[name,secret]of parameters.secrets){const answer=yield {secret,name};if(answer?.status==='resolved')state.parameters[name]=answer.value;else{state.parameters[name]=null;diagnostic({code:'FLOW_PARAMETER_SECRET_UNRESOLVED',parameter:name,status:answer?.status??'unbound'});}}
  let succeeded,failure=null;
  try{succeeded=yield* run(definition.actions);}catch(cause){if(cause instanceof FlowSuspended)return {status:'Waiting',suspended:{actionPath:cause.actionPath,wait:clone(cause.wait)},actions:clone(state.results),...(response?{response}:{})};
   // After the Response answered, a failure is the run's outcome, not the caller's answer.
   if(!response||cause?.code==='NotResumable')throw cause;failure=cause;succeeded=false;}
  const outcome=stopped()&&!terminated||terminatedCancelled?'Cancelled':terminatedFailure||failure||!succeeded?'Failed':'Succeeded';
  if(response&&!rowLike){const cause=terminatedFailure??failure;onOutcome?.({status:outcome,...(outcome==='Failed'?{error:{code:cause?.code??'LocalFlowFailed',message:cause?.message??'Local flow actions failed after the Response.'}}:{})});return response;}
  if(outcome==='Cancelled'){if(!answersWithout)throw new DataError('The flow run was cancelled before it answered with a Response.',409,'FlowRunCancelled');return {status:'Cancelled',actions:clone(state.results)};}
  if(terminatedFailure)throw terminatedFailure;if(unconsumed.size)diverged('(end of run)');
  if(answersWithout){if(!succeeded)fail('Local triggered flow actions failed.',400,'LocalFlowFailed');return {status:'Succeeded',actions:clone(state.results)};}fail('Local flow completed without a Response.',400,'LocalFlowFailed');})(),call);
}

// ---- tracked runs (flow-runs.mjs) -------------------------------------------------------------------------------------

const canonicalId=value=>String(value??'').replace(/[{}]/g,'').toLowerCase();
/** The run store's definition fingerprint: a resume refuses a definition that changed since the run started. */
export const flowDefinitionHash=definition=>createHash('sha256').update(stringifyExactJson(definition??null)).digest('hex');
/** Without a pack flowIdentities profile the trigger's own Dataverse connection principal (project connections) is the flow's. */
export function triggerPrincipal(connectors,definition,connectionReferences){
 const host=Object.values(definition?.triggers??{})[0]?.inputs?.host;if(!connectors||!host?.apiId)return undefined;
 try{return connectors.resolve({apiId:host.apiId,connectionName:host.connectionName??null,connectionReferences}).principal??undefined;}catch{return undefined;}
}
/**
 * One flow run through the run store `runs` (flow-runs.mjs): start (or resume: { runId, outcome } replays the journal as
 * mocks), execute inside wrap(fn) (the caller's transaction), journal the executed connector actions, then suspend on a
 * waiting action or complete Succeeded/Failed. Run store writes happen outside wrap, so a failed transaction keeps them.
 * flowOf(processId) answers a child flow's { definition, mode, steps, serviceProfile, connectors, connectionReferences, secrets }
 * (organization-host.mjs cloudFlow). Without runs this is executeFlowDefinition inside wrap, exactly as before.
 * A Waiting answer carries runId; onRun(runId) is called once the run is started or resumed.
 */
export async function runTrackedFlow({runs=null,processId,trigger=null,wrap=fn=>fn(),flowOf=runs?.flowOf??null,depth=0,resume=null,onRun=null,...args}){
 if(!runs)return wrap(()=>executeFlowDefinition(args));
 const definitionHash=flowDefinitionHash(args.definition);let runId,steps=args.steps??{},input=args.input,correlationId=args.context?.correlationId??null,parameters,replay=[];
 // The non-secret parameter values are frozen at run start; a resume replays them instead of the current environment
 // variable values. unverified: that a native run binds its parameter values once per run.
 // An on-demand run (context.background: no Response needed) keeps that context across a resume.
 let replayJournal={},background=Boolean(args.context?.background);
 // A resume replays the journal by iteration key (context.journal); the steps are the ones configured at start, so a first-iteration mock never stands in for a later iteration.
 if(resume){let configured;({steps,configured,input,correlationId,parameters,replay=[],journal:replayJournal={},background=false}=await runs.resume(resume.runId,resume.outcome,{definitionHash}));steps=configured??steps;runId=resume.runId;}
 else{parameters=flowParameters(args.definition,args.store).values;runId=(await runs.start({processId:canonicalId(processId),trigger,input,correlationId,definitionHash,steps,parameters,background})).id;}
 onRun?.(runId);
 // A child flow (action type Workflow) is its own tracked run, one level deeper, inside the parent's transaction.
 const runChildFlow=async(target,body,{canSuspend=false}={})=>{
  if(depth+1>FLOW_MAX_DEPTH)throw new DataError('Child flows nest deeper than '+FLOW_MAX_DEPTH+' levels.',400,'ChildFlowDepthExceeded');
  const flow=typeof flowOf==='function'?flowOf(canonicalId(target)):null;
  if(!flow?.definition)throw new DataError('The child flow has no exported definition in the selected sources.',404,'ChildFlowNotFound');
  if(['mock','disabled','handler'].includes(flow.mode))throw new DataError('The child flow is locally '+flow.mode+'; only its exported definition can run as a child.',501,'ChildFlowNotExecutable');
  if(inspectFlowTrigger(flow.definition).kind!=='manual')throw new DataError('A child flow needs a manual (Button) Request trigger.',400,'ChildFlowTriggerUnsupported');
  const answer=await runTrackedFlow({runs,processId:target,trigger:'ChildFlow',flowOf,depth:depth+1,definition:flow.definition,input:body,store:args.store,
   serviceProfile:flow.serviceProfile,steps:flow.steps,connectors:flow.connectors??args.connectors,connectionReferences:flow.connectionReferences,secrets:flow.secrets??args.secrets,
   diagnostic:args.diagnostic,limits:args.limits,context:{correlationId,initiatingUserId:args.context?.initiatingUserId??null}});
  // The parent action ends with the child's Response (https://learn.microsoft.com/power-automate/create-child-flows): a child
  // that answered before it waits answers the parent now and keeps running. A child that waits before answering suspends the
  // parent on a wait of kind child: flow-runs.mjs records the ownership (parent run, child run) and the child's completion
  // resumes the parent; the child is never cancelled for it (a parent inside a loop suspends on its iteration's journal key). A parent that cannot
  // suspend (an untracked run) still cancels it.
  if(answer?.status==='Waiting'&&answer.response)return {statusCode:answer.response.status,headers:answer.response.headers??{},body:answer.response.body??null};
  if(answer?.status==='Waiting'){
   if(canSuspend)return {statusCode:202,headers:{},body:null,suspended:{kind:'child',id:answer.runId}};
   await runs.cancel(answer.runId);throw new DataError('A child flow that waits cannot resume a parent action that has no run id to suspend on (an untracked run); the child was cancelled.',501,'ChildFlowSuspendUnsupported');
  }
  return {statusCode:answer.status,headers:answer.headers??{},body:answer.body??null};
 };
 // The run's cancellation signal (runs.cancel aborts it) joins the caller's; outcome: the run's own end after a Response answered.
 const journal=[],cancel=runs.signalOf?.(runId)??null,signal=cancel&&args.context?.signal?AbortSignal.any([cancel,args.context.signal]):cancel??args.context?.signal??null;let result,failure,outcome=null;
 try{result=await wrap(()=>executeFlowDefinition({...args,input,steps,...(parameters?{parameters}:{}),journal:(path,entry)=>journal.push([path,entry]),onOutcome:value=>{outcome=value;},context:{...args.context,...(background?{background}:{}),correlationId,runId,runChildFlow,replay,journal:replayJournal,...(signal?{signal}:{})}}));}catch(error){failure=error;}
 if(runs.get(runId)?.status!=='Running'){if(failure)throw failure;return result;} // cancelled meanwhile: its status stays
 for(const[path,entry]of journal)await runs.journal(runId,path,entry);
 if(failure){await runs.complete(runId,failure.code==='FlowRunCancelled'?{status:'Cancelled'}:{status:'Failed',error:{code:failure.code??'LocalFlowFailed',message:failure.message}});throw failure;}
 if(result?.status==='Waiting'){await runs.suspend(runId,{actionPath:result.suspended.actionPath,wait:result.suspended.wait});return {...result,runId};}
 // A Response answer is kept as the run's outputs, so a parent waiting on this run as its child resumes with it.
 if(result?.status==='Cancelled'){await runs.complete(runId,{status:'Cancelled'});return result;}
 // The run's outcome is its own: the Response answered the caller, a later failure still fails the run.
 await runs.complete(runId,{status:outcome?.status??'Succeeded',...(outcome?.error?{error:outcome.error}:{}),...(Number.isInteger(result?.status)?{outputs:{statusCode:result.status,headers:result.headers??{},body:result.body??null}}:{})});return result;
}
