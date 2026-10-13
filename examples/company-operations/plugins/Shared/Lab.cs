using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace Paqvilo.Demo.Lab {
 public sealed class Config {
  public int schemaVersion {get;set;} = 1;
  public string captureMode {get;set;} = "TraceOnly";
  public string writerId {get;set;}
  public string[] trustedWriterIds {get;set;} = new string[0];
  public string collectorUrl {get;set;}
  public string collectorAudience {get;set;}
  public int timeoutMs {get;set;} = 2000;
  public int order {get;set;}
  public string configVersion {get;set;} = "lab-v1";
  public string teamId {get;set;}
  public string[] chainStepIds {get;set;} = new string[0];
  public bool allowAnonymousObservation {get;set;} = false;
  public string[] anonymousObservationTables {get;set;} = new string[0];
  public bool allowOwnedEvidenceDeletion {get;set;} = false;
  public bool ChainStep(Guid id)=>chainStepIds.Any(s=>Guid.TryParse(s,out var g)&&g==id);
  public static Config Parse(string json) {
   var c=string.IsNullOrWhiteSpace(json)?new Config():new JavaScriptSerializer().Deserialize<Config>(json);
   if(c==null||c.schemaVersion!=1||c.timeoutMs<100||c.timeoutMs>2000||!new[]{"TraceOnly","TransactionalLab","DurableCollector"}.Contains(c.captureMode))throw new InvalidPluginExecutionException("CO invalid unsecure configuration.");
   if(c.captureMode=="TransactionalLab"&&!Guid.TryParse(c.writerId,out _))throw new InvalidPluginExecutionException("CO recording writer not configured.");
   if(c.allowAnonymousObservation&&(c.anonymousObservationTables==null||c.anonymousObservationTables.Length==0||c.anonymousObservationTables.Length>32||c.anonymousObservationTables.Any(t=>string.IsNullOrEmpty(t)||!System.Text.RegularExpressions.Regex.IsMatch(t,"^[a-z][a-z0-9_]*$"))))throw new InvalidPluginExecutionException("CO anonymous observation requires explicit allowed tables.");
   if(c.allowOwnedEvidenceDeletion&&(!Guid.TryParse(c.writerId,out var maintenanceWriter)||c.trustedWriterIds.Length!=1||!c.Trusted(maintenanceWriter)))throw new InvalidPluginExecutionException("CO owned evidence deletion requires one explicit trusted SDK writer.");
   if(c.captureMode=="DurableCollector"&&(!Uri.TryCreate(c.collectorUrl,UriKind.Absolute,out var u)||u.Scheme!="https"||u.IsLoopback||!string.IsNullOrEmpty(u.Query)||string.IsNullOrEmpty(c.collectorAudience)))throw new InvalidPluginExecutionException("CO durable collector is not configured.");
   return c;
  }
  public bool Trusted(Guid id) => trustedWriterIds.Any(s=>Guid.TryParse(s,out var g)&&g==id);
 }
 public abstract class LabPlugin:IPlugin {
  protected readonly Config Configuration;
  protected readonly bool SecurePresent,SecureValid;
  protected readonly string SecureVersion;
  protected LabPlugin(string unsecure,string secure){Configuration=Config.Parse(unsecure);SecurePresent=!string.IsNullOrWhiteSpace(secure);if(SecurePresent){try{var x=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(secure);SecureValid=x.ContainsKey("syntheticSecret")&&x["syntheticSecret"] is string&&x.ContainsKey("version")&&x["version"] is string&&System.Text.RegularExpressions.Regex.IsMatch((string)x["version"],"^[a-zA-Z0-9._-]{1,40}$");SecureVersion=SecureValid?(string)x["version"]:null;}catch{SecureValid=false;}}}
  public abstract void Execute(IServiceProvider provider);
  protected IPluginExecutionContext Context(IServiceProvider p)=>(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));
  protected IOrganizationService Service(IServiceProvider p,Guid id)=>((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(id);
  protected static Entity Before(IPluginExecutionContext c)=>c.PreEntityImages.Contains("Before")?c.PreEntityImages["Before"]:null;
  protected static Entity Merge(Entity before,Entity target){var e=new Entity(target.LogicalName,target.Id);if(before!=null)foreach(var x in before.Attributes)e[x.Key]=x.Value;foreach(var x in target.Attributes)e[x.Key]=x.Value;return e;}
  protected static Guid Lookup(Entity e,string name)=>e?.GetAttributeValue<EntityReference>(name)?.Id??Guid.Empty;
  protected static Entity Target(IPluginExecutionContext c)=>c.InputParameters.Contains("Target")?c.InputParameters["Target"] as Entity:null;
  protected static bool PlatformField(Entity t,string k)=>new[]{"modifiedby","modifiedon","modifiedonbehalfby","utcconversiontimezonecode","timezoneruleversionnumber"}.Contains(k)||k==t.LogicalName+"id"&&t.GetAttributeValue<Guid>(k)==t.Id;
  protected static void Require(bool value,string message){if(!value)throw new InvalidPluginExecutionException("CO "+message);}
 }
 public static class Snapshot {
  public static string Json(object x)=>new JavaScriptSerializer{MaxJsonLength=2097152,RecursionLimit=80}.Serialize(x);
  public static string Hash(string x){using(var h=SHA256.Create())return string.Concat(h.ComputeHash(Encoding.UTF8.GetBytes(x)).Select(b=>b.ToString("x2")));}
  static bool Sensitive(string key)=>new[]{"secret","token","password","authorization","cookie","credential","secureconfiguration","header"}.Any(s=>key.IndexOf(s,StringComparison.OrdinalIgnoreCase)>=0);
  public static object Value(object x,int depth=0,string name=""){
   if(Sensitive(name))return new{type=x?.GetType().FullName,redacted=true};
   if(depth>10)return new{type=x?.GetType().FullName,truncated=true};
   if(x==null)return null;
   if(x is Entity e)return new{type="Entity",logicalName=e.LogicalName,id=e.Id,attributes=e.Attributes.ToDictionary(a=>a.Key,a=>Value(a.Value,depth+1,a.Key)),keyAttributes=e.KeyAttributes.ToDictionary(a=>a.Key,a=>Value(a.Value,depth+1,a.Key)),rowVersion=e.RowVersion,entityState=e.EntityState?.ToString(),formattedValues=e.FormattedValues.ToDictionary(a=>a.Key,a=>(object)(Sensitive(a.Key)?"[redacted]":a.Value)),relatedEntities=e.RelatedEntities.Count};
   if(x is EntityReference r)return new{type="EntityReference",logicalName=r.LogicalName,id=r.Id,name=r.Name,keyAttributes=r.KeyAttributes.ToDictionary(a=>a.Key,a=>Value(a.Value,depth+1,a.Key))};
   if(x is EntityCollection ec)return new{type="EntityCollection",count=ec.Entities.Count,moreRecords=ec.MoreRecords,pagingCookie=ec.PagingCookie,totalRecordCount=ec.TotalRecordCount,totalRecordCountLimitExceeded=ec.TotalRecordCountLimitExceeded,entities=ec.Entities.Take(250).Select(a=>Value(a,depth+1)).ToArray(),truncated=ec.Entities.Count>250};
   if(x is EntityReferenceCollection refs)return refs.Select(a=>Value(a,depth+1)).ToArray();
   if(x is Money m)return new{type="Money",value=m.Value};
   if(x is OptionSetValue o)return new{type="OptionSetValue",value=o.Value};
   if(x is OptionSetValueCollection os)return new{type="OptionSetValueCollection",values=os.Select(a=>a.Value).ToArray()};
   if(x is AliasedValue av)return new{type="AliasedValue",entity=av.EntityLogicalName,attribute=av.AttributeLogicalName,value=Value(av.Value,depth+1,av.AttributeLogicalName)};
   if(x is Relationship rel)return new{type="Relationship",schemaName=rel.SchemaName,primaryEntityRole=rel.PrimaryEntityRole?.ToString()};
   if(x is QueryBase q)return Query(q);
   if(x is DateTime dt)return new{type="DateTime",value=(dt.Kind==DateTimeKind.Unspecified?dt:dt.ToUniversalTime()).ToString("o"),kind=dt.Kind.ToString()};
   if(x is Guid||x is bool||x is byte||x is int||x is long||x is double||x is decimal)return new{type=x.GetType().Name,value=x};
   if(x is string s)return new{type="String",value=s.Length<=16384?s:s.Substring(0,16384),truncated=s.Length>16384};
   return new{type=x.GetType().FullName,unsupported=true};
  }
  static object Filter(FilterExpression f)=>new{op=f.FilterOperator.ToString(),conditions=f.Conditions.Select(c=>new{entityName=c.EntityName,attribute=c.AttributeName,op=c.Operator.ToString(),compareColumns=c.CompareColumns,values=c.Values.Select(v=>Value(v)).ToArray()}).ToArray(),filters=f.Filters.Select(Filter).ToArray()};
  static object Columns(ColumnSet c)=>c==null?(object)new{unavailable=true}:new{allColumns=c.AllColumns,columns=c.Columns?.ToArray(),attributeExpressionsAvailable=c.AttributeExpressions!=null,attributeExpressions=c.AttributeExpressions?.Select(a=>new{alias=a.Alias,attributeName=a.AttributeName,aggregateType=a.AggregateType.ToString(),hasGroupBy=a.HasGroupBy,dateTimeGrouping=a.DateTimeGrouping.ToString()}).ToArray()};
  static object Page(PagingInfo p)=>p==null?(object)new{unavailable=true}:new{p.Count,p.PageNumber,p.PagingCookie,p.ReturnTotalRecordCount};
  static object Link(LinkEntity l)=>new{fromEntity=l.LinkFromEntityName,fromAttribute=l.LinkFromAttributeName,toEntity=l.LinkToEntityName,toAttribute=l.LinkToAttributeName,join=l.JoinOperator.ToString(),alias=l.EntityAlias,columns=Columns(l.Columns),criteria=Filter(l.LinkCriteria),orders=l.Orders.Select(o=>new{attribute=o.AttributeName,order=o.OrderType.ToString()}).ToArray(),links=l.LinkEntities.Select(Link).ToArray()};
  public static object Query(QueryBase q){
   if(q is FetchExpression f)return new{type="FetchExpression",xml=f.Query};
   if(q is QueryExpression x)return new{type="QueryExpression",entity=x.EntityName,columns=Columns(x.ColumnSet),criteria=x.Criteria!=null?Filter(x.Criteria):null,links=x.LinkEntities.Select(Link).ToArray(),distinct=x.Distinct,topCount=x.TopCount,noLock=x.NoLock,page=Page(x.PageInfo),orders=x.Orders.Select(o=>new{attribute=o.AttributeName,entityName=o.EntityName,alias=o.Alias,order=o.OrderType.ToString()}).ToArray()};
   if(q is QueryByAttribute b)return new{type="QueryByAttribute",entity=b.EntityName,columns=Columns(b.ColumnSet),attributes=b.Attributes.ToArray(),values=b.Values.Select(v=>Value(v)).ToArray(),orders=b.Orders.Select(o=>new{attribute=o.AttributeName,order=o.OrderType.ToString()}).ToArray(),page=Page(b.PageInfo)};
   return new{type=q.GetType().FullName,unsupported=true};
  }
  static object Variables(ParameterCollection v)=>v.Where(p=>p.Key=="tag"||p.Key.StartsWith("pqvd.lab.",StringComparison.Ordinal)).ToDictionary(p=>p.Key,p=>Value(p.Value,0,p.Key));
  static void Extension(Dictionary<string,object> result,string key,bool available,Func<object> getter){if(!available){result[key]=new{interfaceAvailable=false,observed=false};return;}try{result[key]=new{interfaceAvailable=true,observed=true,values=getter()};}catch(Exception e){result[key]=new{interfaceAvailable=true,observed=false,readErrorType=e.GetType().Name};}}
  public static int ContextVersion(IPluginExecutionContext c)=>c is IPluginExecutionContext7?7:c is IPluginExecutionContext6?6:c is IPluginExecutionContext5?5:c is IPluginExecutionContext4?4:c is IPluginExecutionContext3?3:c is IPluginExecutionContext2?2:1;
  static object BoundedImage(Entity e){if(e==null)return null;var copy=new Entity(e.LogicalName,e.Id){RowVersion=e.RowVersion,EntityState=e.EntityState};foreach(var a in e.Attributes.Take(64))copy[a.Key]=a.Value;foreach(var a in e.KeyAttributes.Take(16))copy.KeyAttributes[a.Key]=a.Value;foreach(var a in e.FormattedValues.Take(64))copy.FormattedValues[a.Key]=a.Value;return new{value=Value(copy),attributeCount=e.Attributes.Count,attributeTruncated=e.Attributes.Count>64,keyAttributeCount=e.KeyAttributes.Count,keyAttributeTruncated=e.KeyAttributes.Count>16,formattedValueCount=e.FormattedValues.Count,formattedValueTruncated=e.FormattedValues.Count>64};}
  static object ImageCollections(EntityImageCollection[] collections)=>collections==null?null:(object)new{count=collections.Length,collections=collections.Take(8).Select(images=>images==null?null:(object)new{count=images.Count,images=images.Take(8).ToDictionary(a=>a.Key,a=>BoundedImage(a.Value)),truncated=images.Count>8}).ToArray(),truncated=collections.Length>8};
  public static object Extensions(IPluginExecutionContext c){
   var result=new Dictionary<string,object>();
   Extension(result,"context2",c is IPluginExecutionContext2,()=>{var x=(IPluginExecutionContext2)c;return new{x.IsPortalsClientCall,x.PortalsContactId};});
   Extension(result,"context4",c is IPluginExecutionContext4,()=>{var x=(IPluginExecutionContext4)c;return new{preEntityImagesCollection=ImageCollections(x.PreEntityImagesCollection),postEntityImagesCollection=ImageCollections(x.PostEntityImagesCollection)};});
   Extension(result,"context5",c is IPluginExecutionContext5,()=>{var x=(IPluginExecutionContext5)c;var agent=x.InitiatingUserAgent;return new{initiatingUserAgentPresent=agent!=null,initiatingUserAgent=Value(agent,0,"requestHeader.initiatingUserAgent")};});
   Extension(result,"context6",c is IPluginExecutionContext6,()=>{var x=(IPluginExecutionContext6)c;return new{environmentId=Value(x.EnvironmentId),tenantId=Value(x.TenantId)};});
   Extension(result,"context7",c is IPluginExecutionContext7,()=>new{((IPluginExecutionContext7)c).IsApplicationUser});
   return result;
  }
  public static object Context(IPluginExecutionContext c,int order){
   var parents=new List<object>();var p=c.ParentContext;
   while(p!=null&&parents.Count<12){parents.Add(new{p.MessageName,p.PrimaryEntityName,p.PrimaryEntityId,p.Stage,p.Mode,p.Depth,p.IsInTransaction,p.UserId,p.InitiatingUserId,p.CorrelationId,p.RequestId,owningExtension=Value(p.OwningExtension),interfaceVersion=ContextVersion(p),extensions=Extensions(p),sharedVariables=Variables(p.SharedVariables)});p=p.ParentContext;}
   return new{schemaVersion=1,c.MessageName,c.PrimaryEntityName,c.PrimaryEntityId,c.SecondaryEntityName,c.Stage,c.Mode,executionOrder=order,c.Depth,c.IsInTransaction,c.UserId,c.InitiatingUserId,c.BusinessUnitId,c.OrganizationId,organizationName=Value(c.OrganizationName),c.CorrelationId,c.RequestId,c.OperationId,c.OperationCreatedOn,c.IsolationMode,c.IsExecutingOffline,c.IsOfflinePlayback,owningExtension=Value(c.OwningExtension),interfaceVersion=ContextVersion(c),extensions=Extensions(c),input=c.InputParameters.ToDictionary(a=>a.Key,a=>Value(a.Value,0,a.Key)),output=c.OutputParameters.ToDictionary(a=>a.Key,a=>Value(a.Value,0,a.Key)),preImages=c.PreEntityImages.ToDictionary(a=>a.Key,a=>Value(a.Value)),postImages=c.PostEntityImages.ToDictionary(a=>a.Key,a=>Value(a.Value)),sharedVariables=Variables(c.SharedVariables),parents,parentTruncated=p!=null};
  }
 }
}
