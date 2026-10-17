using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.ServiceModel;
using System.Web.Script.Serialization;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.WebServiceClient;
using Paqvilo.Demo.Lab;

// Read-only native SDK driver. OAuth is stdin-only, never part of its receipt.
// All operations are constrained to explicit owned Equipment/Run controls.
public static class SdkProjectionDriver {
 static readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=8*1024*1024,RecursionLimit=64};
 static Dictionary<string,object> Map(object value){return value as Dictionary<string,object>??new Dictionary<string,object>();}
 static string Text(Dictionary<string,object> row,string field){object value;return row.TryGetValue(field,out value)?Convert.ToString(value,CultureInfo.InvariantCulture):null;}
 static bool Flag(Dictionary<string,object> row,string field){object value;return row.TryGetValue(field,out value)&&value!=null&&Convert.ToBoolean(value);}
 static ColumnSet Columns(string mode){switch(mode){case "empty":return new ColumnSet(false);case "name":return new ColumnSet("pqvd_name");case "pk":return new ColumnSet("pqvd_equipmentid");case "all":return new ColumnSet(true);default:throw new InvalidOperationException("Unsupported bounded column mode.");}}
 static string Xml(string value){return System.Security.SecurityElement.Escape(value);}
 static object Execute(IOrganizationService service,Dictionary<string,object> plan){
  var kind=Text(plan,"kind");var mode=Text(plan,"columnMode");var operation=Guid.Parse(Text(plan,"operationId"));var target=Guid.Parse(Text(plan,"equipmentId"));var run=Guid.Parse(Text(plan,"canaryRunId"));var utc=Text(plan,"markerUtc");if(utc==null||utc.Length!=31||!utc.StartsWith("CO-UTC:",StringComparison.Ordinal))throw new InvalidOperationException("Bounded UTC marker required.");
  var count=Flag(plan,"countFixture");QueryBase query=null;Entity record=null;EntityCollection collection=null;
  if(kind=="Retrieve"){if(count)throw new InvalidOperationException("Count fixtures require RetrieveMultiple.");var request=new RetrieveRequest{Target=new EntityReference("pqvd_equipment",target),ColumnSet=Columns(mode)};request["tag"]="CO-OP:"+operation;record=((RetrieveResponse)service.Execute(request)).Entity;}
  else if(kind=="QueryExpression"){
   var q=new QueryExpression("pqvd_equipment"){ColumnSet=Columns(mode)};q.Criteria.AddCondition(count?"pqvd_canaryrunid":"pqvd_equipmentid",ConditionOperator.Equal,count?run:target);q.Criteria.AddCondition("pqvd_name",ConditionOperator.NotEqual,"CO-OP:"+operation);q.Criteria.AddCondition("pqvd_name",ConditionOperator.NotEqual,utc);q.AddOrder("pqvd_equipmentid",OrderType.Ascending);
   if(count){q.PageInfo.Count=5000;q.PageInfo.PageNumber=1;object total;if(plan.TryGetValue("totalCount",out total)&&total!=null)q.PageInfo.ReturnTotalRecordCount=Convert.ToBoolean(total);}query=q;
  }else if(kind=="FetchExpression"){
   var columns=mode=="all"?"<all-attributes />":mode=="empty"?"":mode=="name"?"<attribute name=\"pqvd_name\" />":"<attribute name=\"pqvd_equipmentid\" />";
   string attrs=count?" count=\"5000\" page=\"1\"":"";object control;if(plan.TryGetValue("distinct",out control))attrs+=" distinct=\""+Convert.ToBoolean(control).ToString().ToLowerInvariant()+"\"";if(plan.TryGetValue("totalCount",out control)&&control!=null)attrs+=" returntotalrecordcount=\""+Convert.ToBoolean(control).ToString().ToLowerInvariant()+"\"";if(Flag(plan,"minActiveRowVersion"))attrs+=" min-active-row-version=\"true\"";
   query=new FetchExpression("<fetch"+attrs+"><entity name=\"pqvd_equipment\">"+columns+"<order attribute=\"pqvd_equipmentid\" /><filter><condition attribute=\""+(count?"pqvd_canaryrunid":"pqvd_equipmentid")+"\" operator=\"eq\" value=\""+(count?run:target)+"\" /><condition attribute=\"pqvd_name\" operator=\"ne\" value=\"CO-OP:"+operation+"\" /><condition attribute=\"pqvd_name\" operator=\"ne\" value=\""+Xml(utc)+"\" /></filter></entity></fetch>");
  }else throw new InvalidOperationException("Only Retrieve and RetrieveMultiple controls are supported.");
  if(query!=null){var request=new RetrieveMultipleRequest{Query=query};request["tag"]="CO-OP:"+operation;collection=((RetrieveMultipleResponse)service.Execute(request)).EntityCollection;}
  return new{id=Text(plan,"id"),operationId=operation,query=query==null?null:Snapshot.Value(query),entity=record==null?null:Snapshot.Value(record),collection=collection==null?null:(object)new{type="EntityCollection",entityName=collection.EntityName,minActiveRowVersion=collection.MinActiveRowVersion,count=collection.Entities.Count,moreRecords=collection.MoreRecords,pagingCookie=collection.PagingCookie,totalRecordCount=collection.TotalRecordCount,totalRecordCountLimitExceeded=collection.TotalRecordCountLimitExceeded,entities=collection.Entities.Select(e=>Snapshot.Value(e)).ToArray(),truncated=false}};
 }
 public static int Main(){
  // Framework 4.6.2 otherwise inherits the host's legacy TLS default. This
  // read-only Dataverse driver requires TLS 1.2 before opening its SDK proxy.
  System.Net.ServicePointManager.SecurityProtocol=System.Net.SecurityProtocolType.Tls12;
  Console.InputEncoding=new System.Text.UTF8Encoding(false);Console.OutputEncoding=new System.Text.UTF8Encoding(false);
  try{var line=Console.ReadLine();if(line==null||line.Length>1024*1024)return 2;var input=Map(Json.DeserializeObject(line));var endpoint=new Uri(Text(input,"endpoint"));if(endpoint.Scheme!="https"||endpoint.UserInfo.Length!=0||endpoint.AbsolutePath!="/XRMServices/2011/Organization.svc/web"||endpoint.Fragment.Length!=0)throw new InvalidOperationException("Explicit Dataverse SDK endpoint required.");var token=Text(input,"accessToken");if(string.IsNullOrEmpty(token)||token.Length>65536||token.Any(char.IsWhiteSpace))throw new InvalidOperationException("Private token input required.");var plans=input["probes"] as object[];if(plans==null||plans.Length<1||plans.Length>32)throw new InvalidOperationException("Bounded SDK controls required.");
   using(var proxy=new OrganizationWebProxyClient(endpoint,TimeSpan.FromSeconds(45),false)){proxy.HeaderToken=token;proxy.SdkClientVersion=typeof(IPlugin).Assembly.GetName().Version.ToString();var service=(IOrganizationService)proxy;foreach(var raw in plans){var plan=Map(raw);try{Console.WriteLine(Json.Serialize(new{kind="result",value=Execute(service,plan)}));}catch(FaultException<OrganizationServiceFault> fault){Console.WriteLine(Json.Serialize(new{kind="fault",id=Text(plan,"id"),errorCode=fault.Detail.ErrorCode}));}catch(Exception fault){Console.WriteLine(Json.Serialize(new{kind="failure",id=Text(plan,"id"),exceptionType=fault.GetType().FullName}));}Console.Out.Flush();}}return 0;
  }catch(Exception error){Console.WriteLine(Json.Serialize(new{kind="driver-failure",exceptionType=error.GetType().FullName}));return 2;}
 }
}
