import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Worker,MessageChannel,receiveMessageOnPort} from 'node:worker_threads';
import {DataError} from './data-error.mjs';
import {localOrganizationService,validateServiceProfile,sdkValueToRecord} from './local-organization-service.mjs';
import {queryExpressionToFetch,prepareFetchForSdk,fetchResultToSdkCollection} from './plugin-sdk-query.mjs';
import {isExactNumeric} from './exact-numeric.mjs';
import {captureSdkResponse} from './plugin-response.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex'),uuid=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const fail=(message,code='LocalPluginClrConfiguration',status=409)=>{throw new DataError(message,status,code);};
const canon=id=>String(id??'').replace(/[{}]/g,'').toLowerCase();
const hostSource=fileURLToPath(new URL('./plugin-clr-host.cs',import.meta.url));
let executionDepth=0;
export const clrExecutionDepth=()=>executionDepth;
export function validateClrDescriptor(value){
 if(!value||typeof value!=='object'||value.trust!=='execute-local-assembly')fail('CLR execution requires an explicit trusted project assembly descriptor.');
 for(const key of ['root','sdkRoot','cacheRoot'])if(typeof value[key]!=='string'||!path.isAbsolute(value[key]))fail('CLR '+key+' must be an explicit absolute project/toolchain path.');
 for(const key of ['assembly','sdkAssembly'])if(typeof value[key]!=='string'||path.isAbsolute(value[key])||!value[key].toLowerCase().endsWith('.dll')||value[key].replaceAll('\\','/').split('/').some(p=>!p||p==='.'||p==='..'||p.includes(':')))fail('CLR '+key+' must be a confined relative DLL path.');
 if(typeof value.typeName!=='string'||!/^[_a-z][\w.+`]{0,249}$/i.test(value.typeName))fail('An exact original CLR typeName is required.');
 if(value.dependencies!==undefined&&(!Array.isArray(value.dependencies)||value.dependencies.length>100||value.dependencies.some(p=>typeof p!=='string'||path.isAbsolute(p)||!p.endsWith('.dll')||p.replaceAll('\\','/').split('/').some(p=>!p||p==='.'||p==='..'||p.includes(':')))))fail('CLR dependencies must be confined relative DLL paths.');
 if(!uuid.test(value.context?.initiatingUserId??'')||!uuid.test(value.context?.organizationId??'')||!uuid.test(value.context?.businessUnitId??''))fail('Explicit initiating user, organization and business unit context GUIDs are required.');
 validateServiceProfile(value.serviceProfile);return value;
}
async function confined(root,relative){const realRoot=await fs.realpath(root),candidate=path.resolve(realRoot,relative);const rel=path.relative(realRoot,candidate);if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))fail('CLR source escaped its declared root.');let current=realRoot;for(const part of rel.split(path.sep)){current=path.join(current,part);if((await fs.lstat(current)).isSymbolicLink())fail('CLR source symlinks are not executable dependencies.');}const actual=await fs.realpath(candidate),stat=await fs.stat(actual);if(actual!==candidate||!stat.isFile()||stat.size>32*1024*1024)fail('CLR dependency must be a regular DLL of at most 32 MiB.');return {path:actual,bytes:await fs.readFile(actual)};}
/** No assembly is discovered or executed automatically. Cache contains only explicitly trusted bytes. */
export async function prepareClrRuntime(descriptor,{compiler}={}){
 validateClrDescriptor(descriptor);if(process.platform!=='win32')fail('The built-in CLR host requires Windows .NET Framework; configure mocks on other platforms.','LocalPluginClrUnavailable',501);
 const assembly=await confined(descriptor.root,descriptor.assembly),sdk=await confined(descriptor.sdkRoot,descriptor.sdkAssembly),dependencies=await Promise.all((descriptor.dependencies??[]).map(relative=>confined(descriptor.root,relative)));
 const names=[assembly,sdk,...dependencies].map(f=>path.basename(f.path).toLowerCase());if(new Set(names).size!==names.length)fail('CLR dependency filenames must be unique.');
 const source=await fs.readFile(hostSource),signature=sha(Buffer.concat([source,assembly.bytes,sdk.bytes,...dependencies.map(f=>f.bytes)]));const cacheParent=path.resolve(descriptor.cacheRoot);await fs.mkdir(cacheParent,{recursive:true});if(await fs.realpath(cacheParent)!==cacheParent)fail('CLR cache root cannot use a symlink.');const directory=path.join(cacheParent,'clr-'+signature+'-'+randomUUID());await fs.mkdir(directory,{recursive:true});if((await fs.lstat(directory)).isSymbolicLink()||await fs.realpath(directory)!==directory)fail('CLR signature directory cannot use a symlink.');
 const files=[];for(const original of [assembly,sdk,...dependencies]){const destination=path.join(directory,path.basename(original.path));try{await fs.writeFile(destination,original.bytes,{flag:'wx'});}catch(cause){if(cause.code!=='EEXIST')throw cause;if(sha(await fs.readFile(destination))!==sha(original.bytes))fail('CLR cache bytes changed.');}files.push({path:destination,sourcePath:original.path,sha256:sha(original.bytes)});}
 const executable=path.join(directory,'paqvilo-plugin-host.exe'),sourceFile=path.join(directory,'paqvilo-plugin-host.cs');for(const file of [...files.map(f=>f.path),executable,sourceFile]){const stat=await fs.lstat(file).catch(c=>{if(c.code==='ENOENT')return null;throw c;});if(stat&&(stat.isSymbolicLink()||!stat.isFile()))fail('CLR cache files must be regular files.');}await fs.writeFile(sourceFile,source);
 const compilerFile=compiler??path.join(process.env.WINDIR??'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
 const build=spawnSync(compilerFile,['/nologo','/target:exe','/out:'+executable,'/reference:'+files[1].path,'/reference:System.Web.Extensions.dll','/reference:System.Runtime.Serialization.dll','/reference:System.ServiceModel.dll',sourceFile],{shell:false,windowsHide:true,encoding:'utf8',timeout:20000,maxBuffer:256*1024});
 if(build.error||build.status!==0)fail('CLR host compilation failed: '+String(build.error?.message??build.stdout??build.stderr).slice(0,4000),'LocalPluginClrBuild',501);
 files.push({path:executable,sha256:sha(await fs.readFile(executable))});const allowed=new Set([...files.map(f=>path.basename(f.path)),path.basename(sourceFile)]);if((await fs.readdir(directory)).some(name=>!allowed.has(name)))fail('CLR cache has unregistered sidecar dependencies.');return {descriptor,executable,assembly:files[0].path,files,directory,allowedFiles:[...allowed],provenance:{kind:'original-clr-assembly',typeName:descriptor.typeName,assemblySha256:files[0].sha256,sdkSha256:files[1].sha256,hostSourceSha256:sha(source),trusted:true,securityModel:'Explicit project backend profile; native process is trusted code, not a security sandbox'}};
}
export function pluginRuntimeDescriptors(packs=[]){const descriptors=new Map();for(const pack of packs)for(const[id,descriptor]of Object.entries(pack.pluginRuntimes??{})){const key=canon(id);if(!uuid.test(key)||descriptors.has(key))fail('Invalid or ambiguous CLR plugin step registration.');descriptors.set(key,descriptor);}return descriptors;}
export async function preparePluginRuntimes(packs=[]){const runtimes=new Map();for(const[id,descriptor]of pluginRuntimeDescriptors(packs))runtimes.set(id,await prepareClrRuntime(descriptor));return runtimes;}
const typed=(type,value)=>({$type:type,value});
export function recordToSdkEntity(store,entity,row,columns={allColumns:true}){
 const mapping=store.resolveMapping(entity),attributes={};for(const[key,value]of Object.entries(row??{})){if(!columns.allColumns&&!(columns.columns??[]).includes(key))continue;if(value==null){attributes[key]=null;continue;}const field=store.fieldDefinition(mapping.logicalName,key)??{},type=String(field.dataverseType??field.type??'').toLowerCase();
  if(value&&typeof value==='object'&&value.id&&value.logical_name)attributes[key]={$type:'EntityReference',logicalName:value.logical_name,id:value.id,name:value.name??null};
  else if(['lookup','customer','owner'].includes(type)&&typeof value==='string'){
   const targets=field.targets;
   if(!uuid.test(value)||!Array.isArray(targets)||targets.length!==1||typeof targets[0]!=='string'||!/^[a-z][\w]*$/i.test(targets[0]))fail('SDK lookup GUID requires one exact source-declared target table.','LocalPluginSdkUnsupported',501);
   attributes[key]={$type:'EntityReference',logicalName:targets[0],id:canon(value),name:null};
  }
  else if(['money','decimal'].includes(type))attributes[key]=typed(type==='money'?'Money':'Decimal',String(value?.value??value));
  else if(type==='bigint')attributes[key]=typed('Int64',String(value?.value??value));
  else if(['double','float'].includes(type)){
   const raw=isExactNumeric(value)?value.value:value,number=typeof raw==='number'?raw:typeof raw==='string'&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)?Number(raw):NaN;
   if(!Number.isFinite(number))fail('SDK Double requires a finite numeric source value.','LocalPluginSdkUnsupported',501);
   attributes[key]=typed('Double',String(number));
  }
  else if(['choice','picklist','state','status','optionset'].includes(type))attributes[key]=typed('OptionSetValue',value?.value??value);
  else if(type==='multiselectpicklist'){
   const values=Array.isArray(value)?value:typeof value==='string'?value.split(',').filter(part=>part.trim()!==''):null;
   if(!values)fail('SDK choices require stored option values.','LocalPluginSdkUnsupported',501);
   attributes[key]={$type:'OptionSetValueCollection',values:values.map(item=>{const raw=item?.value??item,number=typeof raw==='number'?raw:typeof raw==='string'&&/^[+-]?\d+$/.test(raw.trim())?Number(raw.trim()):NaN;if(!Number.isInteger(number)||number< -2147483648||number>2147483647)fail('SDK choices require Int32 option values.','LocalPluginSdkUnsupported',501);return typed('OptionSetValue',number);})};
  }
  else if(['datetime','date'].includes(type))attributes[key]=typed('DateTime',value);
  else if(type==='uniqueidentifier'||key===mapping.idColumn)attributes[key]=typed('Guid',value);
  else attributes[key]=structuredClone(value);
 }return {$type:'Entity',logicalName:mapping.logicalName,id:row?.[mapping.idColumn]??'00000000-0000-0000-0000-000000000000',attributes};
}
export function sdkQueryParameters(query){
 if(query.linkEntities?.length)fail('Linked QueryExpression requires the typed FetchXML execution adapter.','LocalPluginSdkUnsupported',501);
 const name=value=>{if(typeof value!=='string'||!/^[a-z][\w]*$/i.test(value))fail('Unsupported SDK query column.','LocalPluginSdkUnsupported',501);return value;};
 const literal=value=>{value=sdkValueToRecord(value);if(value===null)return 'null';if(isExactNumeric(value))return value.value;if(typeof value==='boolean'||typeof value==='number')return String(value);if(typeof value==='string')return "'"+value.replaceAll("'","''")+"'";fail('Unsupported SDK query value.','LocalPluginSdkUnsupported',501);};
 const condition=c=>{if(c.entityName)fail('SDK alias conditions require a configured mock.','LocalPluginSdkUnsupported',501);const attribute=name(c.attributeName),values=c.values??[],ops={Equal:'eq',NotEqual:'ne',GreaterThan:'gt',GreaterEqual:'ge',LessThan:'lt',LessEqual:'le'};if(ops[c.operatorName]&&values.length===1)return `${attribute} ${ops[c.operatorName]} ${literal(values[0])}`;if(['Null','NotNull'].includes(c.operatorName)&&!values.length)return `${attribute} ${c.operatorName==='Null'?'eq':'ne'} null`;if(['In','NotIn'].includes(c.operatorName)&&values.length)return '('+values.map(v=>`${attribute} ${c.operatorName==='In'?'eq':'ne'} ${literal(v)}`).join(c.operatorName==='In'?' or ':' and ')+')';fail('Unsupported SDK condition operator: '+c.operatorName,'LocalPluginSdkUnsupported',501);};
 const filter=f=>{if(!['And','Or'].includes(f.operatorName??'And'))fail('Unsupported SDK filter operator.','LocalPluginSdkUnsupported',501);return [...(f.conditions??[]).map(condition),...(f.filters??[]).map(filter).filter(Boolean)].map(v=>'('+v+')').join(f.operatorName==='Or'?' or ':' and ');};
 const params={};if(query.distinct||query.pageInfo?.pageNumber>1||query.pageInfo?.pagingCookie)fail('SDK distinct/continuation requires an explicit adapter.','LocalPluginSdkUnsupported',501);if(query.orders?.length)params.$orderby=query.orders.map(o=>name(o.attributeName)+(o.descending?' desc':' asc')).join(',');if(query.$type==='QueryByAttribute'){if(query.attributes?.length!==query.values?.length)fail('SDK attribute query length mismatch.','LocalPluginSdkUnsupported',501);params.$filter=(query.attributes??[]).map((attributeName,i)=>condition({attributeName,operatorName:'Equal',values:[query.values[i]]})).join(' and ');}else{if(query.distinct||query.pageInfo?.pageNumber>1||query.pageInfo?.pagingCookie)fail('SDK distinct/continuation requires an explicit adapter.','LocalPluginSdkUnsupported',501);params.$filter=filter(query.criteria??{});if(query.orders?.length)params.$orderby=query.orders.map(o=>name(o.attributeName)+(o.descending?' desc':' asc')).join(',');}
 if(query.topCount!=null)params.$top=query.topCount;else if(query.pageInfo?.count>0)params.$top=query.pageInfo.count;if(!query.columnSet?.allColumns&&query.columnSet?.columns?.length)params.$select=query.columnSet.columns.map(name).join(',');return params;
}
export function dispatchSdkCall(args){const {store,message}=args,previous=store.pluginParentContext;if(message.parentContext){if(message.parentContext.$type!=='ExecutionContext'||Buffer.byteLength(JSON.stringify(message.parentContext))>4*1024*1024)fail('SDK ParentContext is invalid or excessive.','LocalPluginInputLimit',413);store.pluginParentContext=structuredClone(message.parentContext);}try{return dispatchSdkCallCore(args);}finally{store.pluginParentContext=previous;}}
function dispatchSdkCallCore({store,profile,message}){
 const readExecute=message.method==='Execute'&&['Retrieve','RetrieveMultiple'].includes(message.arguments?.[0]?.requestName);
 if(store.pluginReadOnly&&['Create','Update','Delete','Associate','Disassociate','Execute'].includes(message.method)&&!readExecute)fail('SDK writes from a RetrieveMultiple observer require a serialized read-operation transaction adapter.','LocalPluginReadWriteUnsupported',501);
 const service=localOrganizationService(store,profile);if(message.userId!==null&&canon(message.userId)!==canon(profile.userId))fail('SDK impersonation is not covered by the configured backend profile.','LocalPluginImpersonationUnsupported',501);
 // null factory user requests Dataverse SYSTEM. It must be explicitly bound, never granted by default.
 if(message.userId===null&&profile.allowSystemFactory!==true)fail('CreateOrganizationService(null) requires explicit system-factory authorization.','LocalPluginImpersonationUnsupported',501);
 const args=message.arguments??[];switch(message.method){
  case 'Execute':{
   const request=args[0],parameters=request?.parameters?.values;
   if(request?.$type!=='OrganizationRequest'||request.parameters?.$type!=='ParameterCollection'||!parameters||typeof parameters!=='object'||Array.isArray(parameters))fail('SDK Execute requires a typed OrganizationRequest and ParameterCollection.','LocalPluginSdkUnsupported',501);
   const shapes={Create:['Target'],Update:['Target'],Delete:['Target'],Retrieve:['Target','ColumnSet'],RetrieveMultiple:['Query'],CreateMultiple:['Targets'],UpdateMultiple:['Targets'],Associate:['Target','Relationship','RelatedEntities'],Disassociate:['Target','Relationship','RelatedEntities']},shape=shapes[request.requestName];
   if(!shape||Object.keys(parameters).some(key=>!shape.includes(key))||shape.some(key=>!Object.hasOwn(parameters,key)))fail('Unsupported SDK Execute request or parameters: '+request.requestName,'LocalPluginSdkUnsupported',501);
   let method=request.requestName,arguments_=shape.map(key=>parameters[key]);
   if(['Associate','Disassociate'].includes(method)){const target=parameters.Target;if(target?.$type!=='EntityReference')fail('SDK relationship request requires an EntityReference Target.');arguments_=[target.logicalName,typed('Guid',target.id),parameters.Relationship,parameters.RelatedEntities];}
   if(['CreateMultiple','UpdateMultiple'].includes(method)){const targets=parameters.Targets;if(targets?.$type!=='EntityCollection'||!Array.isArray(targets.entities))fail('Bulk SDK request requires a typed Targets EntityCollection.');return invokeSdkMethod({store,service,message:{...message,method,arguments:[targets]}},true);}
   if(['Delete','Retrieve'].includes(method)){const target=parameters.Target;if(target?.$type!=='EntityReference')fail('SDK '+method+'Request requires an EntityReference.');arguments_=[target.logicalName,typed('Guid',target.id),...(method==='Retrieve'?[parameters.ColumnSet]:[])];}
   return invokeSdkMethod({store,service,message:{...message,method,arguments:arguments_}},true);
  }
  default:return invokeSdkMethod({store,service,message},false);
 }
}
function invokeSdkMethod({store,service,message},namedResponse){
 const args=message.arguments??[],method=message.method;
 const table=['Create','Update'].includes(method)?args[0]?.logicalName:['CreateMultiple','UpdateMultiple'].includes(method)?args[0]?.entities?.[0]?.logicalName:method==='RetrieveMultiple'?args[0]?.entityName??/<entity\s[^>]*name=["'](\w+)["']/i.exec(args[0]?.query??'')?.[1]:args[0];
 const entity=typeof table==='string'?store.resolveMapping(table).logicalName:null;
 const captured=captureSdkResponse(store,method.toLowerCase(),entity,responseToken=>executeSdkMethod({store,service,message,responseToken})),defaults=method==='Create'?{id:captured.value}:method==='Retrieve'?{BusinessEntity:captured.value}:method==='RetrieveMultiple'?{BusinessEntityCollection:captured.value}:method==='CreateMultiple'?{Ids:captured.value}:{};
 const results=captured.results??defaults;
 if(namedResponse){const mapped=structuredClone(results),aliases=method==='Retrieve'?[['BusinessEntity','Entity']]:method==='RetrieveMultiple'?[['BusinessEntityCollection','EntityCollection']]:[];for(const[from,to]of aliases)if(Object.hasOwn(mapped,from)){if(Object.hasOwn(mapped,to))fail('Plugin output contains conflicting context and SDK response result aliases.','LocalPluginResponseUnsupported',501);mapped[to]=mapped[from];delete mapped[from];}return {$type:'OrganizationResponse',responseName:method,results:mapped};}
 // These defaults mirror the installed SDK response getters; original-DLL tests
 // qualify the missing-key behavior separately from native organization faults.
 if(method==='Create')return Object.hasOwn(results,'id')?results.id:typed('Guid','00000000-0000-0000-0000-000000000000');
 if(method==='Retrieve')return results.BusinessEntity??null;
 if(method==='RetrieveMultiple')return results.BusinessEntityCollection??null;
 return captured.value;
}
function executeSdkMethod({store,service,message,responseToken}){
 const args=message.arguments??[];switch(message.method){
  case 'CreateMultiple':case 'UpdateMultiple':{const result=service.bulk(message.method.toLowerCase(),args[0].entities,{responseToken});return message.method==='CreateMultiple'?{$type:'GuidArray',values:result.ids.map(value=>typed('Guid',value))}:null;}
  case 'Create':{const entity=args[0];if(entity?.$type!=='Entity')fail('SDK Create requires an Entity.');const row=service.create(entity.logicalName,{...sdkValueToRecord(entity),...(entity.id&&!/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(entity.id)?{[service.mapping(entity.logicalName).idColumn]:entity.id}:{})},{responseToken});return typed('Guid',row[service.mapping(entity.logicalName).idColumn]);}
  case 'Update':{const entity=args[0];if(entity?.$type!=='Entity')fail('SDK Update requires an Entity.');service.update(entity.logicalName,entity.id,sdkValueToRecord(entity),{responseToken});return null;}
  case 'Delete':service.remove(args[0],sdkValueToRecord(args[1]),{responseToken});return null;
  case 'Associate':case 'Disassociate':return service.associate(args[0],sdkValueToRecord(args[1]),args[2],args[3],message.method==='Associate',{responseToken});
  case 'Retrieve':return recordToSdkEntity(store,args[0],service.get(args[0],sdkValueToRecord(args[1]),args[2],{responseToken}),args[2]);
  case 'RetrieveMultiple':{const query=args[0];let rows,entity=query.entityName;if(query.$type==='FetchExpression'||query.$type==='QueryExpression'&&query.linkEntities?.length){
   const xml=query.$type==='FetchExpression'?query.query:queryExpressionToFetch(query,store);entity=/<entity\s[^>]*name=["'](\w+)["']/i.exec(xml)?.[1];const answer=service.fetch(xml,{sdkResult:true,sdkQuery:query,sdkResponseToken:responseToken});return answer.sdkCollection??fetchResultToSdkCollection(store,entity,answer,recordToSdkEntity,{hiddenId:answer.sdkHiddenId,rootColumns:query.columnSet});
  }else if(['QueryExpression','QueryByAttribute'].includes(query.$type)){const params=sdkQueryParameters(query),primary=service.mapping(entity).idColumn;if(!query.columnSet?.allColumns&&!query.columnSet?.columns?.length)params.$select=primary;if(params.$select&&!params.$select.split(',').includes(primary))params.$select+=','+primary;rows=service.query(entity,params,{responseToken}).value;}
  else fail('Unsupported SDK query structure.','LocalPluginSdkUnsupported',501);return {$type:'EntityCollection',entities:rows.map(row=>recordToSdkEntity(store,entity,row,query.columnSet??{allColumns:true})),moreRecords:false,totalRecordCount:-1,pagingCookie:null};}
  default:fail('Unsupported SDK service method: '+message.method,'LocalPluginSdkUnsupported',501);
 }
}
export function executeSdkFetch(store,xml,execute){const prepared=prepareFetchForSdk(xml,store),answer=execute(prepared.xml);Object.defineProperty(answer,'sdkHiddenId',{value:prepared.hiddenId,configurable:true});return answer;}
/** Synchronous pipeline RPC; no queued DataStore.create/update await can deadlock this thread. */
export function executeClrPlugin(runtime,input,{store,diagnostic=()=>{}}){
 if(syncFs.realpathSync(runtime.directory)!==runtime.directory||syncFs.lstatSync(runtime.directory).isSymbolicLink()||syncFs.readdirSync(runtime.directory).some(name=>!runtime.allowedFiles.includes(name)))fail('CLR cache directory or dependencies changed.','LocalPluginSourceChanged',409);
 for(const file of runtime.files)for(const checked of [file.path,...(file.sourcePath?[file.sourcePath]:[])]){const stat=syncFs.lstatSync(checked);if(stat.isSymbolicLink()||!stat.isFile()||sha(syncFs.readFileSync(checked))!==file.sha256)fail('Trusted CLR bytes changed after preparation.','LocalPluginSourceChanged',409);}
 if(sha(syncFs.readFileSync(hostSource))!==runtime.provenance.hostSourceSha256)fail('CLR host source changed; restart to prepare the new host.','LocalPluginSourceChanged',409);
 if(Buffer.byteLength(JSON.stringify(input))>4*1024*1024)fail('CLR context exceeds 4 MiB.','LocalPluginInputLimit',413);
 const timeout=Math.max(100,Math.min(runtime.descriptor.timeoutMs??2000,10000)),{port1,port2}=new MessageChannel(),signal=new SharedArrayBuffer(4),flags=new Int32Array(signal);
 const worker=new Worker(new URL('./plugin-clr-worker.mjs',import.meta.url),{workerData:{port:port2,signal,executable:runtime.executable,input:{...input,assembly:runtime.assembly,typeName:runtime.descriptor.typeName,unsecureConfiguration:runtime.descriptor.unsecureConfiguration??null,secureConfiguration:runtime.descriptor.secureConfiguration??null},timeout},transferList:[port2]});
 worker.on('error',()=>{}); // The synchronous deadline reports worker failure and closes the owned host.
 const deadline=Date.now()+timeout+1000;let calls=0,result,ownedPid;executionDepth++;try{if(executionDepth>8)fail('CLR nested execution depth exceeds eight.','LocalPluginDepth',400);while(!result){let packet;while((packet=receiveMessageOnPort(port1))){const message=packet.message;if(message.kind==='owned-child'){if(!Number.isInteger(message.pid)||message.pid<=0)fail('Invalid owned CLR process.','LocalPluginProtocol',500);ownedPid=message.pid;diagnostic({code:'PLUGIN_CLR_HOST_STARTED',pid:ownedPid});}else if(message.kind==='rpc'){let value,error;try{if(++calls>1000)fail('CLR SDK call limit exceeded.','LocalPluginCallLimit',413);value=dispatchSdkCall({store,profile:runtime.descriptor.serviceProfile,message});}catch(cause){error={code:cause.code??'LocalPluginSdkError',message:cause.message};const inner=cause.details?.innerCode??(cause.code==='NotFound'?'0x80040217':null);if(/^0x[a-f\d]{8}$/i.test(inner??''))error.organizationServiceFault={errorCode:parseInt(inner,16)|0,message:cause.message,timestamp:new Date().toISOString(),errorDetails:cause.details?.sourceException?.exceptionDetails??{},provenance:'Local modeled SDK fault; native timestamp/correlation/stack are not available'};}port1.postMessage({kind:'rpc-answer',value,error});}else if(message.kind==='trace'){if(typeof message.message!=='string'||message.message.length>16384)fail('CLR trace exceeds the local limit.','LocalPluginOutputLimit',413);diagnostic({code:'PLUGIN_CLR_TRACE',message:message.message});}else if(message.kind==='failure'){const details={sourceException:{type:message.exceptionType??null,errorCode:message.errorCode??null,operationStatus:message.operationStatus??null,exceptionDetails:message.exceptionDetails??null}};if(Number.isInteger(message.errorCode))details.innerCode=message.exceptionType==='Microsoft.Xrm.Sdk.InvalidPluginExecutionException'&&(message.errorCode>>>0)===0x80131500?'0x80040265':'0x'+(message.errorCode>>>0).toString(16).padStart(8,'0');throw new DataError(message.message,message.code==='LocalPluginTimeout'?504:400,message.code??'PluginValidation',details);}else if(message.kind==='result')result=message;else fail('Unknown CLR protocol result.','LocalPluginProtocol',500);}if(result)break;if(Date.now()>deadline)fail('CLR host/worker did not complete within the configured deadline.','LocalPluginTimeout',504);Atomics.wait(flags,0,0,20);Atomics.store(flags,0,0);}}
 finally{executionDepth--;if(ownedPid)try{process.kill(ownedPid);}catch(cause){if(cause.code!=='ESRCH')diagnostic({code:'PLUGIN_CLR_CLEANUP',message:'Owned CLR process cleanup failed: '+cause.code});}port1.postMessage({kind:'cancel'});port1.close();void worker.terminate();if(ownedPid){let closed=false;const stopDeadline=Date.now()+1000;while(Date.now()<stopDeadline){try{process.kill(ownedPid,0);}catch(cause){if(cause.code==='ESRCH'){closed=true;break;}}Atomics.wait(flags,0,0,10);}diagnostic({code:'PLUGIN_CLR_HOST_STOPPED',pid:ownedPid,absenceVerified:closed});}}
 return {...result,provenance:runtime.provenance,sdkCalls:calls};
}
export function clrContext({runtime,store,step,entity,operation,stage,target,record,previous,frame,depth}){
 const descriptor=runtime.descriptor,context=descriptor.context,parent=store.pluginParentContext,primary=store.resolveMapping(entity).idColumn;
 const preValidationParent=stage!==10&&(step.contract?.mode??0)===0&&['create','update','delete'].includes(operation)&&frame.preValidationContext;
 if(preValidationParent&&!frame.preValidationSharedDetached){frame.sharedVariables={$type:'ParameterCollection',values:{}};frame.preValidationSharedDetached=true;}
 const image=(row,registration)=>{if(!row)return null;return recordToSdkEntity(store,entity,row,{allColumns:!registration.attributes?.length,columns:registration.attributes??[]});};const preImages={},postImages={};for(const registration of step.images??[]){if([0,2].includes(registration.type)&&previous)preImages[registration.alias||registration.name]=image(previous,registration);if([1,2].includes(registration.type)&&stage===40&&operation!=='delete')postImages[registration.alias||registration.name]=image(record,registration);}
 const bulk=['createmultiple','updatemultiple'].includes(operation),messageName={retrievemultiple:'RetrieveMultiple',createmultiple:'CreateMultiple',updatemultiple:'UpdateMultiple'}[operation]??operation[0].toUpperCase()+operation.slice(1);
 const bulkImages=(rows,post)=>({$type:'EntityImageCollectionArray',values:frame.targets.map((_,index)=>({$type:'EntityImageCollection',values:Object.fromEntries((step.images??[]).filter(registration=>(post?[1,2]:[0,2]).includes(registration.type)&&rows[index]).map(registration=>[registration.alias||registration.name,image(rows[index],registration)]))}))});
 // The main operation populates system results once. Keep custom values and
 // subsequent PostOperation replacements across ranks for every message shape.
 frame.outputParameters??={$type:'ParameterCollection',values:{}};
 if(stage===40&&!frame.systemOutputsPopulated){
  const values=operation==='create'?{id:typed('Guid',record[primary])}:operation==='createmultiple'?{Ids:{$type:'GuidArray',values:record.bulkIds.map(value=>typed('Guid',value))}}:operation==='retrieve'?{BusinessEntity:frame.entity}:operation==='retrievemultiple'?{BusinessEntityCollection:frame.collection}:{};
  frame.outputParameters={$type:'ParameterCollection',values:{...frame.outputParameters.values,...values}};frame.systemOutputsPopulated=true;
 }
 return {expectedAssemblyName:step.assemblyName??null,context:{Stage:stage,Mode:step.contract?.mode??0,Depth:parent?Number(parent.values.Depth)+1:depth,MessageName:messageName,PrimaryEntityName:entity,PrimaryEntityId:typed('Guid',record[primary]),UserId:typed('Guid',descriptor.serviceProfile.userId),InitiatingUserId:typed('Guid',context.initiatingUserId),OrganizationId:typed('Guid',context.organizationId),OrganizationName:context.organizationName??'',BusinessUnitId:typed('Guid',context.businessUnitId),CorrelationId:typed('Guid',frame.correlationId??=parent?.values.CorrelationId?.value??randomUUID()),OperationId:typed('Guid',frame.operationId??=randomUUID()),OperationCreatedOn:typed('DateTime',frame.createdOn??=new Date().toISOString()),IsInTransaction:store.pluginInTransaction===true,IsExecutingOffline:false,IsOfflinePlayback:false,IsolationMode:step.isolationMode??2,OwningExtension:{$type:'EntityReference',logicalName:'sdkmessageprocessingstep',id:step.id,name:step.name},ParentContext:preValidationParent||parent||null,...(bulk?{PreEntityImagesCollection:bulkImages(frame.previousRecords??[],false),PostEntityImagesCollection:bulkImages(stage===40?frame.records??[]:[],true)}:{})},inputParameters:{$type:'ParameterCollection',values:frame.associationParameters??(bulk?{Targets:{$type:'EntityCollection',entities:frame.targets,moreRecords:false,totalRecordCount:-1,pagingCookie:null}}:operation==='retrievemultiple'?{Query:frame.query}:operation==='retrieve'?{Target:{$type:'EntityReference',logicalName:entity,id:record[primary]},ColumnSet:{$type:'ColumnSet',...frame.columns}}:{Target:operation==='delete'?{$type:'EntityReference',logicalName:entity,id:record[primary]}:recordToSdkEntity(store,entity,{...target,[primary]:record[primary]})})},outputParameters:frame.outputParameters,sharedVariables:frame.sharedVariables??{$type:'ParameterCollection',values:{}},preImages,postImages};
}
