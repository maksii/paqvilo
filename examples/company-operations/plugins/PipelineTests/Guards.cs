using System;
using System.Linq;
using System.Collections.Generic;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Paqvilo.Demo.Lab;

namespace Paqvilo.Demo.PipelineTests {
 public sealed class OperationIntentGuard:LabPlugin {
  public OperationIntentGuard(string u,string s):base(u,s){}
  static readonly string[] ClientUpdates={"pqvd_authoredquery","pqvd_logicalqueryhash","pqvd_physicalqueryhash","pqvd_clientsummary","pqvd_liquidxml","pqvd_clientfinishedat"};
  static readonly string[] ServerUpdates={"pqvd_capturestate","pqvd_serversummary","pqvd_receivedqueryhash","pqvd_receivedlinkcount","pqvd_backendfirstat","pqvd_backendlastat","pqvd_collectorreference"};
  public override void Execute(IServiceProvider p){var c=Context(p);var trusted=Configuration.Trusted(c.UserId);if(c.MessageName=="Delete"){Require(trusted,"operation deletion is restricted to recording administrators.");return;}var t=Target(c);if(t==null)return;
   if(c.MessageName=="Update"){Require(t.Attributes.Keys.All(k=>PlatformField(t,k)||ClientUpdates.Contains(k)||trusted&&ServerUpdates.Contains(k)),"operation identity, run, actor and markers are immutable; backend fields require recorder identity. Rejected fields: "+string.Join(",",t.Attributes.Keys.Where(k=>!PlatformField(t,k)&&!ClientUpdates.Contains(k)&&!(trusted&&ServerUpdates.Contains(k)))));return;}
   if(c.MessageName!="Create")return;var forbidden=t.Attributes.Keys.Where(k=>t[k]!=null&&!(k=="pqvd_capturestate"&&t.GetAttributeValue<OptionSetValue>(k)?.Value==183270000)&&(ServerUpdates.Contains(k)||new[]{"pqvd_runnercontactid","pqvd_actorprovenance","pqvd_markertime","pqvd_markerutc","pqvd_markeroperation"}.Contains(k))).ToArray();Require(trusted||forbidden.Length==0,"operation server fields cannot be supplied by the browser. Rejected fields: "+string.Join(",",forbidden));
   if(t.Id==Guid.Empty)t.Id=Guid.NewGuid();var runId=Lookup(t,"pqvd_runid");Require(runId!=Guid.Empty,"operation must belong to an existing run.");var run=Service(p,c.UserId).Retrieve("pqvd_testrun",runId,new ColumnSet("pqvd_runnercontactid"));var actor=run.GetAttributeValue<EntityReference>("pqvd_runnercontactid");Require(actor!=null,"run actor is missing.");t["pqvd_runnercontactid"]=actor;
   foreach(var name in new[]{"pqvd_attempt","pqvd_pagenumber"})Require(t.GetAttributeValue<int>(name)>=1,"operation indices start at one.");Require(Guid.TryParse(t.GetAttributeValue<string>("pqvd_pairkey"),out _),"operation pair key must be a GUID.");
   var lane=t.GetAttributeValue<OptionSetValue>("pqvd_lane")?.Value;Require(trusted||lane==183270000||lane==183270001,"portal intent lane must be Liquid or WebAPI.");Require(new[]{"Retrieve","RetrieveMultiple","Create","Update","Delete","Associate","Disassociate","Assign","SetState","Upsert","pqvd_EchoLabContext"}.Contains(t.GetAttributeValue<string>("pqvd_expectedmessage")),"expected message is not allowlisted.");
   var anonymous=t.GetAttributeValue<string>("pqvd_actorprovenance")=="AnonymousPortal.ConfiguredSDKIntent";
   if(anonymous)Require(trusted&&Configuration.allowAnonymousObservation&&(lane==183270000||lane==183270001)&&t.GetAttributeValue<string>("pqvd_expectedmessage")=="RetrieveMultiple"&&Configuration.anonymousObservationTables.Contains(t.GetAttributeValue<string>("pqvd_roottable"),StringComparer.OrdinalIgnoreCase),"anonymous read intents require a configured trusted SDK writer and allowed read table.");
   var utc=DateTime.UtcNow;t["pqvd_markertime"]=utc;t["pqvd_markerutc"]="CO-UTC:"+utc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ",System.Globalization.CultureInfo.InvariantCulture);t["pqvd_markeroperation"]="CO-OP:"+t.Id.ToString("D").ToLowerInvariant();t["pqvd_capturestate"]=new OptionSetValue(183270000);t["pqvd_actorprovenance"]=anonymous?"AnonymousPortal.ConfiguredSDKIntent":trusted?"SDKConfiguredIdentity.RelationshipClaim":"PortalRelationshipClaim";
  }
 }
 public sealed class EvidenceWriteGuard:LabPlugin {
  public EvidenceWriteGuard(string u,string s):base(u,s){}
  bool OwnedMaintenanceDelete(IServiceProvider provider,IPluginExecutionContext context){
   if(!Configuration.allowOwnedEvidenceDeletion||context.MessageName!="Delete"||context.PrimaryEntityName!="pqvd_pluginevent"||context.Depth!=1||context.ParentContext!=null||!Guid.TryParse(Configuration.writerId,out var writer)||context.InitiatingUserId!=writer||!Configuration.Trusted(writer))return false;
   if(!(context is IPluginExecutionContext2 portal))return false;try{if(portal.IsPortalsClientCall)return false;}catch{return false;}
   if(!context.InputParameters.Contains("Target")||!(context.InputParameters["Target"] is EntityReference target)||target.LogicalName!="pqvd_pluginevent"||target.Id==Guid.Empty||!context.SharedVariables.Contains("tag")||!(context.SharedVariables["tag"] is string tag)||!tag.StartsWith("CO-OWNED-EVIDENCE-DELETE:",StringComparison.Ordinal)||!Guid.TryParse(tag.Substring(25),out var intentId))return false;
   var service=Service(provider,writer);var intent=service.Retrieve("pqvd_testoperation",intentId,new ColumnSet("createdby","pqvd_caseid","pqvd_variant","pqvd_pairkey","pqvd_runid","pqvd_lane","pqvd_expectedmessage","pqvd_roottable","pqvd_actorprovenance","pqvd_markertime"));
   var timestamp=intent.GetAttributeValue<DateTime>("pqvd_markertime");var age=DateTime.UtcNow-timestamp.ToUniversalTime();
   if(Lookup(intent,"createdby")!=writer||intent.GetAttributeValue<string>("pqvd_caseid")!="ARCHIVE-OWNED-EVENT:"+target.Id.ToString("D")||intent.GetAttributeValue<string>("pqvd_expectedmessage")!="Delete"||intent.GetAttributeValue<string>("pqvd_roottable")!="pqvd_pluginevent"||intent.GetAttributeValue<OptionSetValue>("pqvd_lane")?.Value!=183270002||intent.GetAttributeValue<string>("pqvd_actorprovenance")!="SDKConfiguredIdentity.RelationshipClaim"||age<TimeSpan.Zero||age>TimeSpan.FromMinutes(30))return false;
   var evidence=service.Retrieve("pqvd_pluginevent",target.Id,new ColumnSet("createdby","pqvd_operationid","pqvd_payloadhash"));var originalId=Lookup(evidence,"pqvd_operationid");
   var payloadHash=evidence.GetAttributeValue<string>("pqvd_payloadhash");
   if(Lookup(evidence,"createdby")!=writer||originalId==Guid.Empty||!System.Text.RegularExpressions.Regex.IsMatch(payloadHash??"","^[a-f0-9]{64}$")||!Guid.TryParse(intent.GetAttributeValue<string>("pqvd_pairkey"),out var pair)||pair!=originalId||intent.GetAttributeValue<string>("pqvd_variant")!="SHA256:"+payloadHash)return false;
   var original=service.Retrieve("pqvd_testoperation",originalId,new ColumnSet("pqvd_runid"));var runId=Lookup(intent,"pqvd_runid");if(runId==Guid.Empty||runId!=Lookup(original,"pqvd_runid"))return false;
   var run=service.Retrieve("pqvd_testrun",runId,new ColumnSet("createdby"));return Lookup(run,"createdby")==writer;
  }
  public override void Execute(IServiceProvider p){var c=Context(p);var trusted=Configuration.Trusted(c.UserId)||OwnedMaintenanceDelete(p,c);if(!trusted){var trace=(ITracingService)p.GetService(typeof(ITracingService));bool? portal=null;Guid? contact=null;try{if(c is IPluginExecutionContext2 x){portal=x.IsPortalsClientCall;contact=x.PortalsContactId;}}catch{}trace.Trace("CO evidence guard rejected message={0} user={1} initiating={2} depth={3} parent={4} portal={5} portalContactEmpty={6} step={7}",c.MessageName,c.UserId,c.InitiatingUserId,c.Depth,c.ParentContext!=null,portal,contact.HasValue?(bool?)(contact.Value==Guid.Empty):null,c.OwningExtension?.Id);}Require(trusted,"server evidence is write restricted.");if(c.MessageName!="Create")return;var t=Target(c);Require(Lookup(t,"pqvd_operationid")!=Guid.Empty,"evidence operation is required.");Require(t.GetAttributeValue<int>("pqvd_partnumber")>=1&&t.GetAttributeValue<int>("pqvd_partcount")>=t.GetAttributeValue<int>("pqvd_partnumber"),"invalid evidence part indices.");Require(t.GetAttributeValue<string>("pqvd_payloadhash")?.Length==64,"evidence full-payload hash is required.");}
 }
 public sealed class RecordingBindingGuard:LabPlugin {
  public RecordingBindingGuard(string u,string s):base(u,s){}
  public override void Execute(IServiceProvider p){var c=Context(p);var t=Target(c);if(t==null)return;var before=Before(c);var row=Merge(before,t);var trusted=Configuration.Trusted(c.UserId);
   if(c.MessageName=="Update"){foreach(var field in c.PrimaryEntityName=="pqvd_testrun"?new[]{"pqvd_runnercontactid","pqvd_runkey"}:new[]{"pqvd_ownercontactid","pqvd_runid"})Require(!t.Contains(field)||Equals(Snapshot.Json(Snapshot.Value(t[field])),Snapshot.Json(Snapshot.Value(before!=null&&before.Contains(field)?before[field]:null))),"recording ownership and run are immutable.");}
   if(c.PrimaryEntityName=="pqvd_testrun"){Require(Lookup(row,"pqvd_runnercontactid")!=Guid.Empty,"run must have a Contact actor.");return;}
   var runId=Lookup(row,"pqvd_runid");Require(runId!=Guid.Empty,"record must have a run.");var service=Service(p,c.UserId);var run=service.Retrieve("pqvd_testrun",runId,new ColumnSet("pqvd_runnercontactid"));
   if(c.PrimaryEntityName=="pqvd_crudprobe"){Require(Lookup(row,"pqvd_ownercontactid")==Lookup(run,"pqvd_runnercontactid"),"probe owner must match run actor.");}
   var operationId=Lookup(row,c.PrimaryEntityName=="pqvd_crudprobe"?"pqvd_activeoperationid":"pqvd_operationid");Entity intent=null;if(operationId!=Guid.Empty){intent=service.Retrieve("pqvd_testoperation",operationId,new ColumnSet("pqvd_runid","pqvd_runnercontactid","pqvd_roottable","pqvd_expectedmessage","pqvd_lane","pqvd_caseid"));Require(Lookup(intent,"pqvd_runid")==runId,"cross-run operation binding denied.");}
   if(c.PrimaryEntityName=="pqvd_testresult")foreach(var field in new[]{"pqvd_attempt","pqvd_pagenumber","pqvd_partnumber","pqvd_partcount"})Require(row.GetAttributeValue<int>(field)>=1,"result indices start at one.");
   if(c.PrimaryEntityName!="pqvd_crudprobe"||!t.Contains("pqvd_triggernonce"))return;var nonce=t.GetAttributeValue<string>("pqvd_triggernonce");Require(Guid.TryParse(nonce,out _),"trigger nonce must be a GUID.");Require(nonce!=before?.GetAttributeValue<string>("pqvd_triggernonce"),"replayed trigger nonce.");Require(operationId!=Guid.Empty,"chain trigger requires operation intent.");var scenario=row.GetAttributeValue<string>("pqvd_pluginscenario");Require(new[]{"ABC","P02","P03","P04","P05","P06","P07","P08","P09","P10","P11","P12","P13","P14"}.Contains(scenario),"scenario is not allowlisted.");var budget=row.GetAttributeValue<int>("pqvd_hopbudget");Require(budget>=1&&budget<=10,"chain budget outside 1..10.");if(new[]{"P08","P13","P14"}.Contains(scenario))Require(Configuration.captureMode=="DurableCollector","this profile requires an external durable collector.");
   var caseId=intent.GetAttributeValue<string>("pqvd_caseid");var caseMatches=scenario=="ABC"?(caseId=="ABC"||caseId=="P01"||caseId?.StartsWith("P01-",StringComparison.Ordinal)==true):(caseId==scenario||caseId?.StartsWith(scenario+"-",StringComparison.Ordinal)==true);Require(intent.GetAttributeValue<string>("pqvd_roottable")=="pqvd_crudprobe"&&intent.GetAttributeValue<string>("pqvd_expectedmessage")=="Update"&&caseMatches&&Lookup(intent,"pqvd_runnercontactid")==Lookup(row,"pqvd_ownercontactid")&&(intent.GetAttributeValue<OptionSetValue>("pqvd_lane")?.Value==183270001||trusted&&intent.GetAttributeValue<OptionSetValue>("pqvd_lane")?.Value==183270002),"probe intent must match Update, probe table, selected profile, run actor and allowed lane.");
  }
 }
 public sealed class ChainNodeGuard:LabPlugin {
  public ChainNodeGuard(string u,string s):base(u,s){}
  bool TrustedInternalAncestor(IPluginExecutionContext c){
   var target=Target(c);var ownerUpdate=c.MessageName=="Update"&&target?.GetAttributeValue<EntityReference>("ownerid") is EntityReference owner&&owner.LogicalName=="team"&&Guid.TryParse(Configuration.teamId,out var team)&&owner.Id==team;
   if(c.MessageName!="Delete"&&!ownerUpdate)return false;
   var operation=Lookup(Before(c),"pqvd_operationid");var status=Before(c)?.GetAttributeValue<string>("pqvd_configstatus");
   var sealedStep=status?.StartsWith("ChainStep:",StringComparison.Ordinal)==true&&Guid.TryParse(status.Substring(10),out var sealedId)&&Configuration.ChainStep(sealedId);
   var soleSdkInitiator=Guid.TryParse(Configuration.writerId,out var writer)&&Configuration.trustedWriterIds.Length==1&&Configuration.Trusted(writer)&&c.InitiatingUserId==writer;
   var parent=c.ParentContext;
   for(int i=0;parent!=null&&i<12;i++,parent=parent.ParentContext){
    if(operation==Guid.Empty||Recording.Operation(parent)!=operation)continue;
    var registered=sealedStep||parent.OwningExtension!=null&&Configuration.ChainStep(parent.OwningExtension.Id);
    if(!registered&&parent.SharedVariables.Contains("pqvd.lab.authorizedChainStepId")&&Guid.TryParse(Convert.ToString(parent.SharedVariables["pqvd.lab.authorizedChainStepId"]),out var qualified))registered=Configuration.ChainStep(qualified);
    if(registered&&Configuration.Trusted(parent.UserId))return true;
    // Internal Dataverse contexts can discard the trusted caller UserId. A sealed
    // registered step and sole SDK initiator corroborate each other; neither alone
    // authorizes a portal mutation. The internal ancestor must retain the same op.
    if(sealedStep&&soleSdkInitiator&&parent.OwningExtension?.LogicalName=="sdkmessageprocessingstep"&&parent.OwningExtension.Name=="ObjectModel Implementation")return true;
   }
   return false;
  }
  public override void Execute(IServiceProvider p){var c=Context(p);var trusted=Configuration.Trusted(c.UserId)||TrustedInternalAncestor(c);if(!trusted){var trace=(ITracingService)p.GetService(typeof(ITracingService));var parent=c.ParentContext;for(int i=0;parent!=null&&i<12;i++,parent=parent.ParentContext)trace.Trace("CO chain guard rejected ancestor message={0} user={1} extension={2} extensionName={3} operation={4} beforeOperation={5} configuredStepCount={6}",parent.MessageName,parent.UserId,parent.OwningExtension?.Id,parent.OwningExtension?.Name,Recording.Operation(parent),Lookup(Before(c),"pqvd_operationid"),Configuration.chainStepIds.Length);}Require(trusted,"chain node mutations require configured SDK identity. Message="+c.MessageName+" User="+c.UserId+" Initiating="+c.InitiatingUserId);var t=Target(c);if(t==null)return;if(c.MessageName=="Update")foreach(var n in new[]{"pqvd_operationid","pqvd_nodecode","pqvd_querymarkerutc"})Require(!t.Contains(n)||Snapshot.Json(Snapshot.Value(t[n]))==Snapshot.Json(Snapshot.Value(Before(c)!=null&&Before(c).Contains(n)?Before(c)[n]:null)),"chain identity and marker are immutable.");if(c.MessageName=="Create"){Require(Lookup(t,"pqvd_operationid")!=Guid.Empty,"node operation is required.");Require(!string.IsNullOrWhiteSpace(t.GetAttributeValue<string>("pqvd_nodecode")),"node code is required.");Require(t.GetAttributeValue<int>("pqvd_hopindex")>=1,"node hop starts at one.");}}
 }
 public sealed class BusinessProjectionGuard:LabPlugin {
  public BusinessProjectionGuard(string u,string s):base(u,s){}
  static void CanaryRun(IOrganizationService service,Entity equipment){var runId=Lookup(equipment,"pqvd_canaryrunid");Require(runId!=Guid.Empty,"disposable equipment must bind an existing test run.");var run=service.Retrieve("pqvd_testrun",runId,new ColumnSet("pqvd_runnercontactid"));Require(Lookup(run,"pqvd_runnercontactid")!=Guid.Empty,"canary run must have its immutable Contact actor.");}
  public override void Execute(IServiceProvider p){var c=Context(p);if(Configuration.Trusted(c.UserId))return;var t=Target(c);
   if(c.PrimaryEntityName=="pqvd_equipment"){
    if(c.MessageName=="Create"){
     Require(t!=null&&!string.IsNullOrWhiteSpace(t.GetAttributeValue<string>("pqvd_name"))&&t.GetAttributeValue<OptionSetValue>("pqvd_equipmentkind")!=null&&t.GetAttributeValue<OptionSetValue>("pqvd_condition")!=null,"canary equipment requires name, kind and condition.");
     Require(t!=null&&t.GetAttributeValue<string>("pqvd_assettag")?.StartsWith("CO-CANARY-",StringComparison.Ordinal)==true,"equipment creation uses disposable canary tags.");Require((t.GetAttributeValue<OptionSetValue>("pqvd_equipmentstate")?.Value??183270000)==183270000,"canary equipment must start in Stock.");t["pqvd_equipmentstate"]=new OptionSetValue(183270000);Require(Lookup(t,"pqvd_currentassignmentid")==Guid.Empty,"new equipment cannot forge current assignment.");var account=Lookup(t,"pqvd_accountid");var roomId=Lookup(t,"pqvd_roomid");Require(account!=Guid.Empty&&roomId!=Guid.Empty,"canary equipment needs owning account and room.");var svc=Service(p,c.UserId);CanaryRun(svc,t);var room=svc.Retrieve("pqvd_room",roomId,new ColumnSet("pqvd_buildingid"));var building=svc.Retrieve("pqvd_building",Lookup(room,"pqvd_buildingid"),new ColumnSet("pqvd_siteid"));var site=svc.Retrieve("pqvd_site",Lookup(building,"pqvd_siteid"),new ColumnSet("pqvd_accountid"));Require(Lookup(site,"pqvd_accountid")==account,"equipment room must belong to its owning account.");return;
    }
    if(c.MessageName=="Delete"){
     var reference=c.InputParameters["Target"] as EntityReference;Require(reference!=null,"equipment delete target missing.");var svc=Service(p,c.UserId);var row=svc.Retrieve("pqvd_equipment",reference.Id,new ColumnSet("pqvd_assettag","pqvd_currentassignmentid","pqvd_equipmentstate","pqvd_canaryrunid"));CanaryRun(svc,row);Require(row.GetAttributeValue<string>("pqvd_assettag")?.StartsWith("CO-CANARY-",StringComparison.Ordinal)==true&&Lookup(row,"pqvd_currentassignmentid")==Guid.Empty&&row.GetAttributeValue<OptionSetValue>("pqvd_equipmentstate")?.Value==183270000,"only unassigned Stock disposable equipment can be deleted.");return;
    }
   }
   // Read-only seed installation until transactional scope/projection services are qualified.
   if(c.MessageName!="Update")throw new InvalidPluginExecutionException("CO business create/delete blocked: projection maintenance is not qualified.");
   Require(c.PrimaryEntityName!="pqvd_accesspermission"&&c.PrimaryEntityName!="pqvd_accessrole","access configuration is provisioner-only.");
   var allowed=new HashSet<string>(new[]{"pqvd_name"});if(c.PrimaryEntityName=="account")allowed=new HashSet<string>(new[]{"name"});if(c.PrimaryEntityName=="contact")allowed=new HashSet<string>(new[]{"firstname","lastname","fullname"});if(c.PrimaryEntityName=="pqvd_orgcontact")allowed.UnionWith(new[]{"pqvd_displayname","pqvd_workemail","pqvd_workphone"});if(c.PrimaryEntityName=="pqvd_equipment")allowed.UnionWith(new[]{"pqvd_manufacturer","pqvd_model","pqvd_serialnumber","pqvd_condition"});if(new[]{"pqvd_finding","pqvd_servicerequest","pqvd_checklistitem","pqvd_worktask"}.Contains(c.PrimaryEntityName))allowed.Add("pqvd_description");if(c.PrimaryEntityName=="pqvd_employmentterms")allowed.Add("pqvd_contractreference");
   Require(t!=null&&t.Attributes.Keys.All(k=>PlatformField(t,k)||allowed.Contains(k)),"unqualified structural, lifecycle, key, date and financial updates require fixture maintenance.");
  }
 }
 public sealed class ProjectionAssociationGuard:LabPlugin {
  public ProjectionAssociationGuard(string u,string s):base(u,s){}
  public override void Execute(IServiceProvider p){var c=Context(p);if(!c.InputParameters.Contains("Relationship")||!(c.InputParameters["Relationship"] is Relationship r))return;if(new[]{"pqvd_access_accounts","pqvd_access_orgcontacts","pqvd_access_departments","pqvd_access_employments","pqvd_access_equipments","pqvd_access_currencies","pqvd_access_referenceaccounts"}.Contains(r.SchemaName))Require(Configuration.Trusted(c.UserId),"access scope projections are fixture-maintenance only.");}
 }
}
