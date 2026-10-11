import {DataError} from './data-error.mjs';
import {localOrganizationService} from './local-organization-service.mjs';
import {parseSelect} from './odata-query.mjs';
import {isExactNumeric,parseNumericLiteral,parseExactJson,stringifyExactJson,decimalParts,compareNumeric,sumNumeric,multiplyNumeric,divideNumeric,exactNumeric} from './exact-numeric.mjs';
const own=(o,k)=>o!=null&&Object.hasOwn(o,k), clone=v=>v===undefined?null:structuredClone(v);
const fail=(message,status=501,code='LocalFlowUnsupported')=>{throw new DataError(message,status,code);};
const unsafe=k=>['__proto__','constructor','prototype'].includes(k);
const builtins=new Set(['Compose','InitializeVariable','SetVariable','IncrementVariable','DecrementVariable','AppendToArrayVariable','AppendToStringVariable','If','Scope','Foreach','Switch','Response','Terminate']);
const operations=new Set(['CreateRecord','UpdateRecord','DeleteRecord','GetItem','ListRecords']);
const unsupportedTriggerSettings=['runtimeConfiguration','runTimeConfiguration','conditions','splitOn','recurrence','operationOptions'];
const responseStatus=code=>Number.isInteger(code)&&code>=200&&code<=599&&(code<300||code>=400);
export function inspectFlowTrigger(definition){
 const triggers=Object.values(definition?.triggers??{});if(triggers.length!==1)return {supported:false,kind:'unknown',errors:['One source trigger is required.']};
 const trigger=triggers[0],settingErrors=unsupportedTriggerSettings.filter(key=>own(trigger,key)).map(key=>'Unsupported source trigger setting: '+key);
 if(trigger.type==='Request'&&trigger.kind==='powerpages'){for(const key of Object.keys(trigger.inputs??{}))if(key!=='schema')settingErrors.push('Unsupported Request trigger input: '+key);return {supported:!settingErrors.length,kind:'powerpages',errors:settingErrors};}
 if(!['OpenApiConnectionWebhook','OpenApiConnection'].includes(trigger.type)||!String(trigger.inputs?.host?.apiId??'').endsWith('/shared_commondataserviceforapps')||trigger.inputs?.host?.operationId!=='SubscribeWebhookTrigger')return {supported:false,kind:trigger.type??'unknown',errors:['This trigger requires an explicit local trigger adapter.']};
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
export function inspectFlowDefinition(definition,steps={}){
 const actions=[],errors=[];let count=0;
 const visit=(map,prefix='',depth=0,inheritedSkip=false,inLoop=false)=>{if(depth>16||!map||typeof map!=='object'||Array.isArray(map)){errors.push('Invalid or excessive action nesting.');return;}for(const[name,action]of Object.entries(map)){
  const key=prefix+name;count++;if(unsafe(name)||!action||typeof action!=='object'){errors.push('Invalid action '+key);continue;}
  const override=steps[key],mode=override?.mode??'exported';
  const connector=action.type==='OpenApiConnection'&&String(action.inputs?.host?.apiId??'').endsWith('/shared_commondataserviceforapps')&&operations.has(action.inputs?.host?.operationId);
  const supported=builtins.has(action.type)||connector;actions.push({key,name,type:action.type,operationId:action.inputs?.host?.operationId??null,supported,mode,external:action.type==='OpenApiConnection'&&!connector||['Http','ApiConnection','ApiConnectionWebhook','OpenApiConnectionWebhook'].includes(action.type)});
  if(!inheritedSkip&&!supported&&!['mock','disabled'].includes(mode))errors.push('Unsupported action '+key+' ('+action.type+'); configure an explicit action mock or disable it.');
  if(override&&!['exported','mock','disabled'].includes(mode))errors.push('Invalid action mode '+key);
  if(action.type==='Response'&&inLoop)errors.push('Response is not allowed within a loop: '+key);
  if(!inheritedSkip&&!['mock','disabled'].includes(mode)){
   if(action.type==='InitializeVariable'&&depth>0)errors.push('InitializeVariable requires the workflow global level: '+key);
   if(action.type==='Response'){const raw=action.inputs?.statusCode??200;if((typeof raw!=='string'||!raw.startsWith('@'))&&!responseStatus(Number(raw)))errors.push('Response requires a 2xx, 4xx or 5xx status code: '+key);}
   for(const setting of ['runtimeConfiguration','retryPolicy','operationOptions','limit','staticResults'])if(own(action,setting))errors.push('Unsupported action setting '+key+'/'+setting+'; configure an explicit mock or disable it.');
   if(action.inputs&&typeof action.inputs==='object'&&own(action.inputs,'retryPolicy'))errors.push('Unsupported action retry policy '+key);
   if(connector){const op=action.inputs.host.operationId,allowed=new Set(['entityName',...(['UpdateRecord','DeleteRecord','GetItem'].includes(op)?['recordId']:[]),...(op==='GetItem'?['$select']:[]),...(op==='ListRecords'?['$select','$filter','$orderby','$top']:[])]);for(const parameter of Object.keys(action.inputs.parameters??{}))if(!allowed.has(parameter)&&!(['CreateRecord','UpdateRecord'].includes(op)&&parameter.startsWith('item/')))errors.push('Unsupported Dataverse parameter '+key+'/'+parameter);}
  }
  if(action.runAfter!=null&&(!action.runAfter||typeof action.runAfter!=='object'||Array.isArray(action.runAfter)))errors.push('Invalid runAfter '+key);
  for(const[dependency,statuses]of Object.entries(action.runAfter??{}))if(!own(map,dependency)||!Array.isArray(statuses)||statuses.length===0||statuses.some(x=>!['Succeeded','Failed','Skipped','TimedOut'].includes(x)))errors.push('Invalid runAfter dependency '+key+'/'+dependency);
  const skipped=inheritedSkip||['disabled','mock'].includes(mode),loop=inLoop||['Foreach','Until'].includes(action.type);if(action.actions)visit(action.actions,key+'/',depth+1,skipped,loop);if(action.else?.actions)visit(action.else.actions,key+'/else/',depth+1,skipped,loop);
  for(const[caseName,branch]of Object.entries(action.cases??{}))visit(branch.actions??{},key+'/case:'+caseName+'/',depth+1,skipped,loop);if(action.default?.actions)visit(action.default.actions,key+'/default/',depth+1,skipped,loop);
 }const visiting=new Set(),visited=new Set();const check=name=>{if(visiting.has(name)){errors.push('Flow runAfter dependency cycle: '+prefix+name);return;}if(visited.has(name))return;visiting.add(name);for(const dep of Object.keys(map[name]?.runAfter??{}))if(own(map,dep))check(dep);visiting.delete(name);visited.add(name);};for(const name of Object.keys(map))check(name);
 const ancestor=(name,target,seen=new Set())=>{if(seen.has(name))return false;seen.add(name);return Object.keys(map[name]?.runAfter??{}).some(dep=>dep===target||own(map,dep)&&ancestor(dep,target,seen));},names=Object.keys(map);for(let a=0;a<names.length;a++)for(let b=a+1;b<names.length;b++)if(!inheritedSkip&&!ancestor(names[a],names[b])&&!ancestor(names[b],names[a]))errors.push('Parallel action branches require an explicit workflow mock: '+prefix+names[a]+' / '+prefix+names[b]);
 };visit(definition?.actions??{});if(count>250)errors.push('Local flow limit is 250 source actions.');
 for(const key of Object.keys(steps))if(!actions.some(a=>a.key===key))errors.push('Unknown configured action '+key);
 return {supported:errors.length===0,actions,errors,inputSchema:Object.values(definition?.triggers??{}).find(t=>t.type==='Request')?.inputs?.schema??null};
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
  case 'body':case 'outputs':case 'actions':arity(1);if(!own(state.results,a[0]))fail('Action output is unavailable.',400,'LocalFlowExpression');return n==='body'?state.results[a[0]].outputs?.body??null:n==='outputs'?state.results[a[0]].outputs:state.results[a[0]];
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
  case 'contains':arity(2);return typeof a[0]==='string'||Array.isArray(a[0])?a[0].includes(a[1]):a[0]&&typeof a[0]==='object'?own(a[0],a[1]):fail('contains() requires a collection.');
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
function connector(action,input,service){
 if(!service)fail('Dataverse flow actions require an explicit project backend identity/security profile.',409,'LocalBackendIdentityRequired');const p=input.parameters??{},entity=p.entityName;
 if(typeof entity!=='string')fail('Dataverse action entityName is missing.',400,'LocalFlowExpression');const values=Object.fromEntries(Object.entries(p).filter(([k])=>k.startsWith('item/')).map(([k,v])=>[k.slice(5),v]));
 switch(action.inputs.host.operationId){
  case 'CreateRecord':return {statusCode:201,body:clone(service.create(entity,values))};
  case 'UpdateRecord':service.update(entity,p.recordId,values);return {statusCode:204,body:{}};
  case 'DeleteRecord':service.remove(entity,p.recordId);return {statusCode:204,body:{}};
  case 'GetItem':{if(p.$select!=null&&typeof p.$select!=='string')fail('GetItem select columns require a comma-separated string.',400,'LocalFlowExpression');const selected=parseSelect(p.$select);if(selected?.some(name=>/^_(.+)_value$/.test(name)))fail('GetItem lookup aliases require an explicit connector projection adapter.');return {statusCode:200,body:service.get(entity,p.recordId,selected?{allColumns:false,columns:selected}:undefined)};}
  case 'ListRecords':{const q={};for(const key of ['$select','$filter','$orderby','$top','$expand'])if(p[key]!==undefined)q[key]=p[key];return {statusCode:200,body:service.query(entity,q)};}
  default:fail('Unsupported local Dataverse flow operation.');
 }
}
// A skipped leaf inherits its predecessor's completion status. A successful
// error handler therefore resolves the failed branch without rewriting history.
function failedCompletion(map,results){
 const predecessors=new Set(Object.values(map??{}).flatMap(action=>Object.keys(action.runAfter??{})));
 const failed=(name,seen=new Set())=>{if(seen.has(name))return false;seen.add(name);const status=results[name]?.status;if(status==='Succeeded')return false;if(['Failed','TimedOut'].includes(status))return true;return Object.keys(map[name]?.runAfter??{}).some(dep=>failed(dep,new Set(seen)));};
 return Object.keys(map??{}).filter(name=>!predecessors.has(name)).some(name=>failed(name));
}
/** Executes imported definitions only. External actions never become successful implicit no-ops. */
export function executeFlowDefinition({definition,input,store,serviceProfile,steps={},diagnostic=()=>{},limits={}}){
 const contract=inspectFlowDefinition(definition,steps),trigger=inspectFlowTrigger(definition);if(!contract.supported)fail(contract.errors.join(' '));if(!trigger.supported)fail(trigger.errors.join(' '));const triggers=Object.values(definition?.triggers??{});if(!input||typeof input!=='object'||Array.isArray(input))fail('The cloud-flow input must be an object.',400,'InvalidRequest');validateFlowInput(input,triggers[0].inputs?.schema);
 const state={input,variables:{},parameters:Object.fromEntries(Object.entries(definition.parameters??{}).filter(([,v])=>own(v,'defaultValue')).map(([k,v])=>[k,v.defaultValue])),results:{},items:[]};const service=serviceProfile?localOrganizationService(store,serviceProfile):null;let budget=0,response,terminated=false;const maxActions=Math.min(limits.maxActions??2000,10000),maxIterations=Math.min(limits.maxIterations??100,1000),deadline=Date.now()+Math.min(limits.timeoutMs??2000,5000);
 const resolve=v=>resolveFlowValue(v,state),trace=(key,action,status,error)=>diagnostic({code:'FLOW_ACTION',action:key,type:action.type,mode:steps[key]?.mode??'exported',status,...(error?{error:{code:error.code??'LocalFlowError',message:error.message}}:{})});
 const variable=(name,value)=>{const v=state.variables[name];if(!v)fail('Unknown flow variable.',400,'LocalFlowExpression');validateFlowInput(value,{type:{integer:'integer',float:'number',boolean:'boolean',string:'string',array:'array',object:'object'}[v.type]},name);v.value=clone(value);};
 const condition=value=>{if(typeof value==='string')return resolve(value);if(!value||typeof value!=='object'||Object.keys(value).length!==1)fail('Unsupported flow condition.');const[fn,args]=Object.entries(value)[0];return evaluate({kind:'call',name:fn,args:[args].flat().map(v=>({kind:'literal',value:typeof v==='object'&&!Array.isArray(v)?condition(v):resolve(v)}))},state);};
 const skip=(map,prefix)=>{for(const[name,action]of Object.entries(map??{})){state.results[name]={status:'Skipped',outputs:{}};trace(prefix+name,action,'Skipped');skip(action.actions,prefix+name+'/');skip(action.else?.actions,prefix+name+'/else/');for(const[branch,c]of Object.entries(action.cases??{}))skip(c.actions,prefix+name+'/case:'+branch+'/');skip(action.default?.actions,prefix+name+'/default/');}};
 const run=(map,prefix='')=>{const pending=new Set(Object.keys(map??{})),localResults={};while(pending.size&&!terminated){let progress=false;for(const name of [...pending]){const action=map[name],key=prefix+name;if(Object.keys(action.runAfter??{}).some(dep=>pending.has(dep)))continue;pending.delete(name);progress=true;if(++budget>maxActions||Date.now()>deadline)fail('Local flow execution limit exceeded.',504,'LocalFlowTimeout');
  const statuses=action.runAfter??{};if(Object.entries(statuses).some(([dep,allowed])=>!allowed.includes(localResults[dep]?.status))){localResults[name]=state.results[name]={status:'Skipped',outputs:{}};trace(key,action,'Skipped');skip(action.actions,key+'/');skip(action.else?.actions,key+'/else/');for(const[branch,c]of Object.entries(action.cases??{}))skip(c.actions,key+'/case:'+branch+'/');skip(action.default?.actions,key+'/default/');continue;}
  const override=steps[key];let outputs={},status='Succeeded',error;
  try{
   if(override?.mode==='disabled'){status='Skipped';}
   else if(override?.mode==='mock'){status=override.status??'Succeeded';if(!['Succeeded','Failed','Skipped','TimedOut'].includes(status))fail('Invalid mock action status.');outputs=clone(override.outputs??{});}
   else switch(action.type){
    case 'Compose':outputs=resolve(action.inputs);break;
    case 'InitializeVariable':for(const v of action.inputs?.variables??[]){if(unsafe(v.name)||own(state.variables,v.name))fail('Duplicate or unsafe variable.');if(!['integer','float','boolean','string','array','object'].includes(v.type))fail('Unsupported variable type.');state.variables[v.name]={type:v.type,value:null};variable(v.name,resolve(v.value));}break;
    case 'SetVariable':variable(action.inputs.name,resolve(action.inputs.value));break;
    case 'IncrementVariable':case 'DecrementVariable':{const name=action.inputs.name,prior=state.variables[name]?.value,delta=resolve(action.inputs.value??1);if(!isExactNumeric(prior)&&typeof prior!=='number'||!isExactNumeric(delta)&&typeof delta!=='number')fail('Numeric variable required.');variable(name,isExactNumeric(prior)||isExactNumeric(delta)?sumNumeric([prior,action.type==='IncrementVariable'?delta:multiplyNumeric([delta,-1])],state.variables[name].type==='integer'?'Int64':'Decimal'):prior+(action.type==='IncrementVariable'?delta:-delta));break;}
    case 'AppendToArrayVariable':{const name=action.inputs.name,prior=state.variables[name]?.value;if(!Array.isArray(prior))fail('Array variable required.');variable(name,[...prior,resolve(action.inputs.value)]);break;}
    case 'AppendToStringVariable':{const name=action.inputs.name,prior=state.variables[name]?.value,value=resolve(action.inputs.value);if(typeof prior!=='string'||typeof value!=='string')fail('String variable required.');variable(name,prior+value);break;}
    case 'If':{const test=condition(action.expression);if(typeof test!=='boolean')fail('Flow condition must be boolean.');skip(test?action.else?.actions:action.actions,key+(test?'/else/':'/'));if(!run(test?action.actions:action.else?.actions,key+(test?'/':'/else/')))status='Failed';break;}
    case 'Scope':if(!run(action.actions,key+'/'))status='Failed';break;
    case 'Foreach':{const values=resolve(action.foreach);if(!Array.isArray(values)||values.length>maxIterations)fail('Foreach requires an array within the iteration limit.');for(const value of values){state.items.push({name,value});try{if(!run(action.actions,key+'/'))status='Failed';}finally{state.items.pop();}if(terminated)break;}break;}
    case 'Switch':{const value=resolve(action.expression),entry=Object.entries(action.cases??{}).find(([,c])=>equivalent(c.case,value));for(const[branch,c]of Object.entries(action.cases??{}))if(branch!==entry?.[0])skip(c.actions,key+'/case:'+branch+'/');if(entry)skip(action.default?.actions,key+'/default/');if(!run(entry?entry[1].actions:action.default?.actions,key+(entry?'/case:'+entry[0]+'/':'/default/')))status='Failed';break;}
    case 'Response':{const answer=resolve(action.inputs??{}),code=Number(answer.statusCode??200);if(!responseStatus(code)||response)fail('Invalid or duplicate flow response.');const body=own(answer,'body')?answer.body:{},headers=answer.headers;if(headers!==undefined&&(!headers||typeof headers!=='object'||Array.isArray(headers)||Object.entries(headers).some(([k,v])=>!/^[!#$%&'*+.^_`|~\w-]+$/.test(k)||typeof v!=='string'||/[\r\n]/.test(v))))fail('Invalid flow Response headers.');response={status:code,body,...(headers?{headers}:{})};outputs={statusCode:code,body,...(headers?{headers}:{})};break;}
    case 'Terminate':{const answer=resolve(action.inputs??{});terminated=true;if(answer.runStatus!=='Succeeded')fail(answer.runError?.message??'Flow terminated with failure.',400,'LocalFlowTerminated');break;}
    case 'OpenApiConnection':outputs=connector(action,resolve(action.inputs),service);break;
    default:fail('Unsupported action '+key);
   }
  }catch(cause){error=cause;status=cause.status===504?'TimedOut':'Failed';outputs={error:{code:cause.code??'LocalFlowError',message:cause.message}};}
  localResults[name]=state.results[name]={status,outputs};trace(key,action,status,error);
  if(Buffer.byteLength(JSON.stringify(state))>4*1024*1024)fail('Local flow state exceeds 4 MiB.',413,'LocalFlowLimit');
 }if(!progress)fail('Flow runAfter dependency cycle.');}return !failedCompletion(map,localResults);};
 const succeeded=run(definition.actions);if(trigger.kind==='dataverse'){if(!succeeded)fail('Local triggered flow actions failed.',400,'LocalFlowFailed');return {status:'Succeeded',actions:clone(state.results)};}if(!response)fail('Local flow completed without a Response.',400,'LocalFlowFailed');return response;
}
