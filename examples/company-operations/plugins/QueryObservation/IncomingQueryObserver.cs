using System;
using System.Linq;
using System.Collections.Generic;
using System.Xml;
using System.Xml.Linq;
using System.IO;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Paqvilo.Demo.Lab;

namespace Paqvilo.Demo.QueryObservation {
 public sealed class IncomingQueryObserver:LabPlugin {
  public IncomingQueryObserver(string unsecure,string secure):base(unsecure,secure){}
  static string Name(string entity)=>entity=="account"?"name":entity=="contact"?"fullname":entity=="transactioncurrency"?"currencyname":"pqvd_name";
  static readonly string[] PrincipalAttributes={"contactid","pqvd_granteecontactid","pqvd_companymanagerprincipalid","pqvd_branchmanagerprincipalid","pqvd_teamleaderprincipalid","pqvd_employeeprincipalid","pqvd_contractorprincipalid","pqvd_hrprincipalid","pqvd_itprincipalid","pqvd_facilitiesprincipalid","pqvd_procurementprincipalid","pqvd_auditorprincipalid","pqvd_orgadminprincipalid","pqvd_ctoprincipalid"};
  static IEnumerable<ConditionExpression> Conditions(FilterExpression f)=>f==null?Enumerable.Empty<ConditionExpression>():f.Conditions.Concat(f.Filters.SelectMany(Conditions));
  static IEnumerable<ConditionExpression> LinkConditions(IEnumerable<LinkEntity> links)=>links==null?Enumerable.Empty<ConditionExpression>():links.SelectMany(l=>Conditions(l.LinkCriteria).Concat(LinkConditions(l.LinkEntities)));
  public static bool PermissionContactBinding(QueryBase query,Guid actor){var values=new List<object>();if(query is QueryExpression q){foreach(var c in Conditions(q.Criteria).Concat(LinkConditions(q.LinkEntities)))if(c.Operator==ConditionOperator.Equal&&PrincipalAttributes.Contains(c.AttributeName,StringComparer.OrdinalIgnoreCase))values.AddRange(c.Values);}else if(query is FetchExpression f){try{using(var reader=XmlReader.Create(new StringReader(f.Query),new XmlReaderSettings{DtdProcessing=DtdProcessing.Prohibit,XmlResolver=null,MaxCharactersInDocument=2097152})){var d=XDocument.Load(reader);foreach(var c in d.Descendants("condition"))if((string)c.Attribute("operator")=="eq"&&PrincipalAttributes.Contains((string)c.Attribute("attribute"),StringComparer.OrdinalIgnoreCase))values.Add((string)c.Attribute("value"));}}catch(XmlException){return false;}}else return false;return actor!=Guid.Empty&&values.Count>0&&values.All(v=>{var g=v is Guid id?id:v is EntityReference r?r.Id:Guid.TryParse(Convert.ToString(v),out var parsed)?parsed:Guid.Empty;return g==actor;});}
  public static string PortalActorBinding(IPluginExecutionContext context,QueryBase query,Guid actor){
   var portal=context as IPluginExecutionContext2;
   if(portal!=null){try{if(portal.IsPortalsClientCall)return actor!=Guid.Empty&&portal.PortalsContactId!=Guid.Empty&&portal.PortalsContactId==actor?"RuntimePortalsContactMatched":null;}catch{return null;}}
   return PermissionContactBinding(query,actor)?"ObservedPermissionContactUnanimity.NotIdentityAttestation":null;
  }
  bool TrustedChildLineage(IPluginExecutionContext c,Guid operation){var parent=c.ParentContext;for(int i=0;parent!=null&&i<12;i++,parent=parent.ParentContext){if(!Configuration.Trusted(parent.UserId)||Recording.Operation(parent)!=operation)continue;if(parent.OwningExtension!=null&&Configuration.ChainStep(parent.OwningExtension.Id))return true;if(parent.SharedVariables.Contains("pqvd.lab.authorizedChainStepId")&&Guid.TryParse(Convert.ToString(parent.SharedVariables["pqvd.lab.authorizedChainStepId"]),out var step)&&Configuration.ChainStep(step))return true;}return false;}
  static int Links(IEnumerable<LinkEntity> links)=>links?.Sum(l=>1+Links(l.LinkEntities))??0;
  public override void Execute(IServiceProvider provider){try{Observe(provider);}catch(Exception ex){((ITracingService)provider.GetService(typeof(ITracingService))).Trace("CO query observer fault type={0} stack={1}",ex.GetType().Name,ex.StackTrace);throw;}}
  void Observe(IServiceProvider provider){
   var c=Context(provider);if(c.MessageName!="RetrieveMultiple"||!c.InputParameters.Contains("Query")||!(c.InputParameters["Query"] is QueryBase q))return;
   var operations=new List<string>();var times=new List<string>();int count=0;string entity=null;
   if(q is FetchExpression f){
    try{using(var reader=XmlReader.Create(new StringReader(f.Query),new XmlReaderSettings{DtdProcessing=DtdProcessing.Prohibit,XmlResolver=null,MaxCharactersInDocument=2097152})){var doc=XDocument.Load(reader,LoadOptions.PreserveWhitespace);var root=doc.Root?.Element("entity");if(root==null)return;entity=(string)root.Attribute("name");count=root.Descendants("link-entity").Count();foreach(var v in root.Elements("filter").SelectMany(x=>x.DescendantsAndSelf("condition"))){if((string)v.Attribute("attribute")!=Name(entity)||(string)v.Attribute("operator")!="ne"||v.Attribute("entityname")!=null)continue;var value=(string)v.Attribute("value");if(value?.StartsWith("CO-OP:",StringComparison.Ordinal)==true)operations.Add(value);if(value?.StartsWith("CO-UTC:",StringComparison.Ordinal)==true)times.Add(value);}}}catch(XmlException){return;}
   }else if(q is QueryExpression x){entity=x.EntityName;count=Links(x.LinkEntities);foreach(var v in Conditions(x.Criteria)){if(v.AttributeName!=Name(entity)||v.Operator!=ConditionOperator.NotEqual||!string.IsNullOrEmpty(v.EntityName))continue;foreach(var value in v.Values.OfType<string>()){if(value.StartsWith("CO-OP:",StringComparison.Ordinal))operations.Add(value);if(value.StartsWith("CO-UTC:",StringComparison.Ordinal))times.Add(value);}}}
   else if(q is QueryByAttribute b&&b.EntityName=="pqvd_chainnode"){
    entity=b.EntityName;for(int i=0;i<b.Attributes.Count;i++){if(b.Attributes[i]=="pqvd_operationid"){var id=b.Values[i] is Guid g?g:(b.Values[i] as EntityReference)?.Id??Guid.Empty;if(id!=Guid.Empty)operations.Add("CO-OP:"+id);}if(b.Attributes[i]=="pqvd_querymarkerutc")times.Add(Convert.ToString(b.Values[i]));}
   }else return;
   var ops=operations.Distinct().ToArray();var utc=times.Distinct().ToArray();if(ops.Length!=1||utc.Length!=1||!Guid.TryParse(ops[0].Substring(6),out var operation))return;
   if(!DateTime.TryParseExact(utc[0].Substring(7),"yyyy-MM-ddTHH:mm:ss.fffZ",System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.AssumeUniversal,out _))return;
   // Validated immutable intent, not inferred authentication from markers.
   var service=Service(provider,Guid.TryParse(Configuration.writerId,out var writer)?writer:c.UserId);var intentQuery=new QueryExpression("pqvd_testoperation"){TopCount=1,ColumnSet=new ColumnSet("pqvd_markerutc","pqvd_markeroperation","pqvd_roottable","pqvd_expectedmessage","pqvd_lane","pqvd_runid","pqvd_runnercontactid","pqvd_actorprovenance")};intentQuery.Criteria.AddCondition("pqvd_testoperationid",ConditionOperator.Equal,operation);var operationRow=service.RetrieveMultiple(intentQuery).Entities.FirstOrDefault();if(operationRow==null)return;
   if(operationRow.GetAttributeValue<string>("pqvd_markerutc")!=utc[0]||operationRow.GetAttributeValue<string>("pqvd_markeroperation")!=ops[0]||!operationRow.Contains("pqvd_runid"))return;
   var lane=operationRow.GetAttributeValue<OptionSetValue>("pqvd_lane")?.Value??0;
   var provenance=operationRow.GetAttributeValue<string>("pqvd_actorprovenance");
   if(lane==183270002&&(!Configuration.Trusted(c.UserId)||provenance!="SDKConfiguredIdentity.RelationshipClaim")){((ITracingService)provider.GetService(typeof(ITracingService))).Trace("CO query capture withheld: SDK intent requires configured caller and provenance operation={0}",operation);return;}
   var controlledChild=c.Depth>1&&entity=="pqvd_chainnode"&&Configuration.Trusted(c.UserId)&&Recording.Operation(c)==operation&&(provenance=="SDKConfiguredIdentity.RelationshipClaim"||provenance=="PortalRelationshipClaim")&&TrustedChildLineage(c,operation);
   if(lane!=183270002&&!controlledChild&&(operationRow.GetAttributeValue<string>("pqvd_roottable")!=entity||operationRow.GetAttributeValue<string>("pqvd_expectedmessage")!="RetrieveMultiple"))return;
   var actorBinding=lane==183270002?"ConfiguredSDKIntent":controlledChild?"ControlledSDKChild":PortalActorBinding(c,q,Lookup(operationRow,"pqvd_runnercontactid"));
   if(actorBinding==null){((ITracingService)provider.GetService(typeof(ITracingService))).Trace("CO query capture withheld: unqualified or mismatched portal actor binding operation={0}",operation);return;}
   var artifact=c.Stage==20&&Configuration.order>=9900?"PluginReceivedQuery.Stage20.Late":"PluginReceivedQuery.Stage"+c.Stage+".Order"+Configuration.order;
   var exact=q is FetchExpression fetch?fetch.Query:Snapshot.Json(Snapshot.Query(q));
   Recording.Capture(provider,Configuration,operation,artifact,new{query=Snapshot.Query(q),physicalQueryHash=Snapshot.Hash(exact),linkCount=count,operationMarkerOccurrences=operations.Count,timeMarkerOccurrences=times.Count,stageAttribution="RegisteredStageOnly.NotFinalSql",actorBinding},q.GetType().Name,count);
  }
 }
 public sealed class QueryShapeMutator:LabPlugin {
  public QueryShapeMutator(string unsecure,string secure):base(unsecure,secure){}
  public override void Execute(IServiceProvider p){var c=Context(p);if(c.PrimaryEntityName!="pqvd_chainnode"||Recording.Operation(c)==Guid.Empty)return;if(c.InputParameters["Query"] is QueryExpression q){q.Criteria.AddCondition("pqvd_nodecode",ConditionOperator.NotEqual,"CO-MUTATOR-RESERVED");}else if(c.InputParameters["Query"] is FetchExpression f){using(var reader=XmlReader.Create(new StringReader(f.Query),new XmlReaderSettings{DtdProcessing=DtdProcessing.Prohibit,XmlResolver=null})){var d=XDocument.Load(reader);d.Root.Element("entity").Add(new XElement("filter",new XAttribute("type","and"),new XElement("condition",new XAttribute("attribute","pqvd_nodecode"),new XAttribute("operator","ne"),new XAttribute("value","CO-MUTATOR-RESERVED"))));f.Query=d.ToString(SaveOptions.DisableFormatting);}}}
 }
}
