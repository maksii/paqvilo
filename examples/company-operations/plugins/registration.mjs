import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import { createHash } from 'node:crypto';
export function localAssemblyIdentity(path){
 if(process.platform!=='win32')return{available:false,reason:'WindowsReflectionReaderUnavailable'};
 const script='$assembly=[System.Reflection.Assembly]::ReflectionOnlyLoadFrom($env:PAQVILO_PLUGIN_INSPECT_PATH);$name=$assembly.GetName();[pscustomobject]@{name=$name.Name;version=$name.Version.ToString();moduleVersionId=$assembly.ManifestModule.ModuleVersionId.ToString()}|ConvertTo-Json -Compress';
 const result=spawnSync(join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:65536,env:{...process.env,PAQVILO_PLUGIN_INSPECT_PATH:path}});
 if(result.status!==0)throw new Error('Assembly metadata reflection inspection failed.');
 const identity=JSON.parse(result.stdout.trim());if(!/^[0-9a-f-]{36}$/i.test(identity.moduleVersionId)||typeof identity.name!=='string'||typeof identity.version!=='string')throw new Error('Assembly reflection identity is invalid.');return{available:true,...identity};
}
export function connectionPath(args=process.argv.slice(2)){const index=args.indexOf('--connection');if(index>=0&&(!args[index+1]||args[index+1].startsWith('--')))throw new Error('--connection requires a saved connection path.');return index>=0?args[index+1]:'.paqvilo/dataverse/provisioning.connection.json';}
export const id = (name) => {const h=createHash('sha256').update(`company-operations/plugins/v1/${name}`).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
export const probeColumns=['pqvd_ownercontactid','pqvd_runid','pqvd_activeoperationid','pqvd_triggernonce','pqvd_pluginscenario','pqvd_hopbudget','pqvd_counter','pqvd_value'];
export const nodeColumns=['pqvd_operationid','pqvd_nodecode','pqvd_parentnodeid','pqvd_hop','pqvd_hopindex','pqvd_scenario','pqvd_requestnonce','pqvd_completionnonce','pqvd_querymarkerutc','pqvd_payloadjson','pqvd_sampletext','pqvd_sampledecimal','pqvd_samplemoney','pqvd_sampledate','pqvd_sampletime','pqvd_sampleboolean','pqvd_samplechoice','pqvd_samplemultichoice','pqvd_samplecontactid','pqvd_configstatus','ownerid','statecode','statuscode','transactioncurrencyid'];
export const assemblies=[{name:'Paqvilo.Demo.QueryObservation',project:'QueryObservation',types:['IncomingQueryObserver','QueryShapeMutator']},{name:'Paqvilo.Demo.PipelineTests',project:'PipelineTests',types:['OperationIntentGuard','EvidenceWriteGuard','RecordingBindingGuard','ChainNodeGuard','BusinessProjectionGuard','ProjectionAssociationGuard','PipelineContextObserver','ChainA','ChainB','ChainC','DepthChain','AsyncContextObserver','EchoLabContext']}];
export function registration(manifest){
 const steps=[];const add=(assembly,type,table,message,stage,order,options={})=>steps.push({key:[type,table,message,stage,order,options.mode??0].join('/'),assembly,type,table,message,stage,order,mode:options.mode??0,...options});
 const business=manifest.tables.filter(t=>!['pqvd_testrun','pqvd_testresult','pqvd_crudprobe','pqvd_testoperation','pqvd_pluginevent','pqvd_chainnode'].includes(t.name));
 for(const t of [...business,{name:'pqvd_chainnode'}])for(const[stage,order]of[[10,10],[20,10],[20,9900],[40,9900]])add(assemblies[0].name,'IncomingQueryObserver',t.name,'RetrieveMultiple',stage,order);
 for(const[table,type]of[['pqvd_testoperation','OperationIntentGuard'],['pqvd_pluginevent','EvidenceWriteGuard'],['pqvd_chainnode','ChainNodeGuard']])for(const message of ['Create','Update','Delete'])add(assemblies[1].name,type,table,message,20,5,{imageColumns:table==='pqvd_chainnode'?nodeColumns:['pqvd_runid','pqvd_runnercontactid','pqvd_operationid'], ...(message!=='Create'?{images:['Before']}: {})});
 for(const table of ['pqvd_testrun','pqvd_testresult','pqvd_crudprobe'])for(const message of ['Create','Update'])add(assemblies[1].name,'RecordingBindingGuard',table,message,20,5,{...(message==='Update'?{images:['Before']}:{}),imageColumns:table==='pqvd_testrun'?['pqvd_runnercontactid','pqvd_runkey']:table==='pqvd_crudprobe'?probeColumns:['pqvd_runid','pqvd_operationid']});
 for(const table of business.filter(t=>t.name!=='transactioncurrency').map(t=>t.name))for(const message of ['Create','Update','Delete'])add(assemblies[1].name,'BusinessProjectionGuard',table,message,20,5);
 for(const table of ['pqvd_crudprobe','pqvd_chainnode'])for(const message of ['Create','Update','Delete','Retrieve','RetrieveMultiple','Assign','SetState','Associate','Disassociate','Upsert'])for(const[stage,order]of[[10,10],[20,10],[40,10],[40,9900]]){
  if(table==='pqvd_crudprobe'&&['Assign','SetState','Associate','Disassociate','Upsert'].includes(message))continue;
  const images=stage===10?[]:message==='Update'?(stage===40?['Before','After']:['Before']):message==='Create'&&stage===40?['After']:message==='Delete'?['Before']:[];
  add(assemblies[1].name,'PipelineContextObserver',table,message,stage,order,{images,imageColumns:table==='pqvd_crudprobe'?probeColumns:nodeColumns,secureProfile:order===9900?'B':'A',...(['Associate','Disassociate'].includes(message)?{global:true}:{})});
 }
 add(assemblies[1].name,'ChainA','pqvd_crudprobe','Update',40,100,{filteringAttributes:['pqvd_triggernonce'],images:['Before','After'],imageColumns:probeColumns,runAsWriter:true});
 add(assemblies[1].name,'ChainB','pqvd_chainnode','Create',40,100,{images:['After'],imageColumns:nodeColumns});
 add(assemblies[1].name,'ChainC','pqvd_chainnode','Update',40,100,{filteringAttributes:['pqvd_hop','pqvd_requestnonce','pqvd_completionnonce'],images:['Before','After'],imageColumns:nodeColumns});
 add(assemblies[1].name,'DepthChain','pqvd_chainnode','Create',40,110,{images:['After'],imageColumns:nodeColumns});
 add(assemblies[1].name,'AsyncContextObserver','pqvd_crudprobe','Update',40,100,{mode:1,filteringAttributes:['pqvd_triggernonce'],images:['After'],imageColumns:probeColumns,runAsWriter:true});
 // The mutator is SDK-only and disabled until its explicit calibration is requested.
 add(assemblies[0].name,'QueryShapeMutator','pqvd_chainnode','RetrieveMultiple',20,100,{disabled:true});
 for(const message of ['Associate','Disassociate'])add(assemblies[1].name,'ProjectionAssociationGuard','*',message,20,5,{global:true});
 return {schemaVersion:1,solution:'PaqviloBehaviorPlugins',assemblies,steps,readiness:{businessProjectionMaintenance:false,durableCollector:false,flowSecret:false,azureIdentityBinding:false,optionalBulk:false,optionalMerge:false}};
}
