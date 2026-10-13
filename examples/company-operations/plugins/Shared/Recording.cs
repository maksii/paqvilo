using System;
using System.Linq;
using System.Text;
using System.Net.Http;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace Paqvilo.Demo.Lab {
 public static class Recording {
  public static object AssemblyIdentity(){var assembly=typeof(Recording).Assembly;var name=assembly.GetName();return new{name=name.Name,version=name.Version.ToString(),moduleVersionId=assembly.ManifestModule.ModuleVersionId};}
  public static bool Receipt(string json,Guid operation,string eventKey,string hash){try{var x=new System.Web.Script.Serialization.JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(json);return x.TryGetValue("accepted",out var accepted)&&accepted is bool a&&a&&x.TryGetValue("durable",out var durable)&&durable is bool d&&d&&x.TryGetValue("payloadHash",out var h)&&Convert.ToString(h)==hash&&x.TryGetValue("receiptId",out var r)&&Convert.ToString(r)==operation+"/"+eventKey;}catch{return false;}}
  public static Guid Operation(IPluginExecutionContext c) {
   if(c.InputParameters.Contains("OperationId")&&c.InputParameters["OperationId"] is Guid apiId)return apiId;
   var t=c.InputParameters.Contains("Target")?c.InputParameters["Target"] as Entity:null;
   foreach(var name in new[]{"pqvd_activeoperationid","pqvd_operationid"}) {
    var r=t?.GetAttributeValue<EntityReference>(name);if(r!=null)return r.Id;
    foreach(var e in c.PostEntityImages.Values.Concat(c.PreEntityImages.Values)){r=e.GetAttributeValue<EntityReference>(name);if(r!=null)return r.Id;}
   }
   var p=c;for(int i=0;p!=null&&i<12;i++,p=p.ParentContext){if(p.SharedVariables.Contains("pqvd.lab.operation")&&Guid.TryParse(Convert.ToString(p.SharedVariables["pqvd.lab.operation"]),out var g))return g;if(p.SharedVariables.Contains("tag")){var tag=Convert.ToString(p.SharedVariables["tag"]);if(tag?.StartsWith("CO-OP:",StringComparison.Ordinal)==true&&Guid.TryParse(tag.Substring(6).Split(';')[0],out var tagged))return tagged;}}
   return Guid.Empty;
  }
  public static bool Capture(IServiceProvider provider,Config cfg,Guid operation,string artifact,object content,string queryType=null,int?links=null) {
   if(operation==Guid.Empty)return false;
   var c=(IPluginExecutionContext)provider.GetService(typeof(IPluginExecutionContext));
   var trace=(ITracingService)provider.GetService(typeof(ITracingService));
   var span=Guid.NewGuid();c.SharedVariables["pqvd.lab.operation"]=operation.ToString();c.SharedVariables["pqvd.lab.span"]=span.ToString();
   string parentSpan=null;var p=c.ParentContext;for(int i=0;p!=null&&i<12;i++,p=p.ParentContext){if(p.SharedVariables.Contains("pqvd.lab.span")){parentSpan=Convert.ToString(p.SharedVariables["pqvd.lab.span"]);break;}}
   var payload=Snapshot.Json(new{schemaVersion=Snapshot.SchemaVersion,assemblyIdentity=AssemblyIdentity(),captureTime=DateTime.UtcNow.ToString("o"),operationId=operation,spanId=span,parentSpanId=parentSpan,artifact,context=Snapshot.Context(c,cfg.order),content,durability=cfg.captureMode=="TransactionalLab"?"DataverseTransaction.RollbackVulnerable":cfg.captureMode});
   var hash=Snapshot.Hash(payload);var eventKey=Snapshot.Hash(span+":"+c.Stage+":"+c.OwningExtension.Id+":"+artifact);
   if(Encoding.UTF8.GetByteCount(payload)>2097152){trace.Trace("CO capture incomplete oversized operation={0} hash={1}",operation,hash);return false;}
   if(cfg.captureMode=="TraceOnly"){trace.Trace("CO backend capture blocked: collector missing operation={0} artifact={1} hash={2}",operation,artifact,hash);return false;}
   if(cfg.captureMode=="DurableCollector"){
    var budgetContext=c;var ancestor=c.ParentContext;for(int i=0;ancestor!=null&&i<12;i++,ancestor=ancestor.ParentContext)if(Operation(ancestor)==operation)budgetContext=ancestor;
    int spent=0;var lineage=c;for(int i=0;lineage!=null&&i<12;i++,lineage=lineage.ParentContext)if(lineage.SharedVariables.Contains("pqvd.lab.transportMs")&&lineage.SharedVariables["pqvd.lab.transportMs"] is int measured)spent=Math.Max(spent,measured);
    var clock=System.Diagnostics.Stopwatch.StartNew();
    try{
     if(spent>=8000){trace.Trace("CO collector total wait budget exceeded operation={0}",operation);return false;}
     var identity=(IManagedIdentityService)provider.GetService(typeof(IManagedIdentityService));if(identity==null){trace.Trace("CO managed identity unavailable operation={0}",operation);return false;}
     var scope=cfg.collectorAudience.EndsWith("/.default",StringComparison.Ordinal)?cfg.collectorAudience:cfg.collectorAudience.TrimEnd('/')+"/.default";var token=identity.AcquireToken(new[]{scope});var remaining=8000-spent-(int)clock.ElapsedMilliseconds;if(remaining<=0){trace.Trace("CO token acquisition exceeded collector budget operation={0}",operation);return false;}
     using(var http=new HttpClient(new HttpClientHandler{AllowAutoRedirect=false})){http.Timeout=TimeSpan.FromMilliseconds(Math.Min(cfg.timeoutMs,remaining));http.MaxResponseContentBufferSize=4096;http.DefaultRequestHeaders.ConnectionClose=true;http.DefaultRequestHeaders.Authorization=new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer",token);var body=Snapshot.Json(new{schemaVersion=1,eventKey,operationId=operation,payloadHash=hash,payload});var response=http.PostAsync(cfg.collectorUrl,new StringContent(body,Encoding.UTF8,"application/json")).GetAwaiter().GetResult();if((int)response.StatusCode!=202||!Receipt(response.Content.ReadAsStringAsync().GetAwaiter().GetResult(),operation,eventKey,hash)){trace.Trace("CO collector receipt invalid operation={0} status={1}",operation,(int)response.StatusCode);return false;}return true;}
    }catch(Exception ex){trace.Trace("CO collector failure operation={0} type={1}",operation,ex.GetType().Name);return false;}finally{int total=spent+(int)Math.Min(int.MaxValue-spent,clock.ElapsedMilliseconds);c.SharedVariables["pqvd.lab.transportMs"]=total;budgetContext.SharedVariables["pqvd.lab.transportMs"]=total;}
   }
   // This explicit laboratory mode participates in the current transaction. No durability claim.
   // Do not catch an SDK write fault and continue inside a broken transaction.
   var service=((IOrganizationServiceFactory)provider.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(Guid.Parse(cfg.writerId));
   var operationRow=service.Retrieve("pqvd_testoperation",operation,new ColumnSet("pqvd_runid","pqvd_capturestate"));
   if(!operationRow.Contains("pqvd_runid")){trace.Trace("CO operation quarantined or unbound operation={0}",operation);return false;}
   var parts=new System.Collections.Generic.List<string>();for(int offset=0;offset<payload.Length;){int len=Math.Min(128000,payload.Length-offset);if(offset+len<payload.Length&&char.IsHighSurrogate(payload[offset+len-1]))len--;parts.Add(payload.Substring(offset,len));offset+=len;}
   for(int i=0;i<parts.Count;i++){
    var e=new Entity("pqvd_pluginevent");e["pqvd_name"]=artifact+" "+span;e["pqvd_operationid"]=new EntityReference("pqvd_testoperation",operation);e["pqvd_eventkey"]=eventKey;e["pqvd_partnumber"]=i+1;e["pqvd_partcount"]=parts.Count;e["pqvd_source"]=new OptionSetValue(183270000);e["pqvd_artifacttype"]=artifact;e["pqvd_capturetime"]=DateTime.UtcNow;e["pqvd_message"]=c.MessageName;e["pqvd_stage"]=c.Stage;e["pqvd_mode"]=c.Mode;e["pqvd_executionorder"]=cfg.order;e["pqvd_depth"]=c.Depth;e["pqvd_isintransaction"]=c.IsInTransaction;e["pqvd_backenduserid"]=c.UserId.ToString();e["pqvd_initiatinguserid"]=c.InitiatingUserId.ToString();e["pqvd_correlationid"]=c.CorrelationId.ToString();e["pqvd_requestid"]=c.RequestId?.ToString();e["pqvd_platformoperationid"]=c.OperationId.ToString();e["pqvd_spanid"]=span.ToString();e["pqvd_parentspanid"]=parentSpan;e["pqvd_querytype"]=queryType;if(links.HasValue)e["pqvd_linkcount"]=links.Value;e["pqvd_contenttype"]="application/json";e["pqvd_payloadtext"]=parts[i];e["pqvd_payloadhash"]=hash;e["pqvd_provenance"]="DataversePlugin.TransactionalLab.RollbackVulnerable";service.Create(e);
   }
   var update=new Entity("pqvd_testoperation",operation);update["pqvd_capturestate"]=new OptionSetValue(183270001);update["pqvd_backendlastat"]=DateTime.UtcNow;update["pqvd_serversummary"]=Snapshot.Json(new{captureMode="TransactionalLab",durability="RollbackVulnerable",complete=false,lastArtifact=artifact,lastSpanId=span,lastPayloadHash=hash,collectorReady=false});service.Update(update);return true;
  }
 }
}
