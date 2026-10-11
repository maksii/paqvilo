// Original Paqvilo host. Project-supplied Microsoft SDK references; no third-party emulator.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Remoting.Messaging;
using System.Runtime.Remoting.Proxies;
using System.Runtime.Remoting;
using System.ServiceModel;
using System.Web.Script.Serialization;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

public static class PaqviloPluginHost {
 static readonly JavaScriptSerializer Json=new JavaScriptSerializer {MaxJsonLength=4*1024*1024,RecursionLimit=64};
 static TextWriter Output;
 static Dictionary<string,object> CurrentContext;
 static Dictionary<string,object> Map(object value){return value as Dictionary<string,object> ?? new Dictionary<string,object>();}
 static object Get(Dictionary<string,object> map,string key,object fallback=null){object value;return map.TryGetValue(key,out value)?value:fallback;}
 static string Str(Dictionary<string,object> map,string key,string fallback=""){return Convert.ToString(Get(map,key,fallback),CultureInfo.InvariantCulture);}
 static IEnumerable<object> Array(object value){return value as object[] ?? (value is ArrayList?((ArrayList)value).Cast<object>():new object[0]);}
 static void Send(object value){Output.WriteLine(Json.Serialize(value));Output.Flush();}
 static object Decode(object value){
  var m=value as Dictionary<string,object>;if(m==null)return value is object[]?((object[])value).Select(Decode).ToArray():value;
  string kind=Str(m,"$type");switch(kind){
   case "Guid":return Guid.Parse(Str(m,"value"));
   case "DateTime":return DateTime.Parse(Str(m,"value"),CultureInfo.InvariantCulture,DateTimeStyles.RoundtripKind);
   case "Decimal":return Decimal.Parse(Str(m,"value"),CultureInfo.InvariantCulture);
   case "Int64":return Int64.Parse(Str(m,"value"),CultureInfo.InvariantCulture);
   case "Bytes":return Convert.FromBase64String(Str(m,"value"));
   case "SdkArray":{var values=Array(Get(m,"values")).Select(Decode);switch(Str(m,"elementType")){case "Entity":return values.Select(v=>(Entity)v).ToArray();case "EntityReference":return values.Select(v=>(EntityReference)v).ToArray();case "OptionSetValue":return values.Select(v=>(OptionSetValue)v).ToArray();case "Money":return values.Select(v=>(Money)v).ToArray();case "EntityCollection":return values.Select(v=>(EntityCollection)v).ToArray();case "QueryExpression":return values.Select(v=>(QueryExpression)v).ToArray();case "String[]":return values.Select(v=>(string[])v).ToArray();default:throw new NotSupportedException("Unsupported SDK array element type: "+Str(m,"elementType"));}}
   case "PrimitiveArray":{var values=Array(Get(m,"values")).Select(Decode);switch(Str(m,"elementType")){case "String":return values.Select(v=>(string)v).ToArray();case "Int32":return values.Select(v=>(int)v).ToArray();case "Boolean":return values.Select(v=>(bool)v).ToArray();case "Int64":return values.Select(v=>(long)v).ToArray();case "Decimal":return values.Select(v=>(decimal)v).ToArray();case "Double":return values.Select(v=>(double)v).ToArray();case "DateTime":return values.Select(v=>(DateTime)v).ToArray();default:throw new NotSupportedException("Unsupported SDK primitive array element type: "+Str(m,"elementType"));}}
   case "Double":{var number=Double.Parse(Str(m,"value"),NumberStyles.Float,CultureInfo.InvariantCulture);if(Double.IsNaN(number)||Double.IsInfinity(number))throw new NotSupportedException("SDK Double requires a finite numeric value.");return number;}
   case "Money":return new Money(Convert.ToDecimal(Get(m,"value"),CultureInfo.InvariantCulture));
   case "OptionSetValue":return new OptionSetValue(Convert.ToInt32(Get(m,"value")));
   case "OptionSetValueCollection":return new OptionSetValueCollection(Array(Get(m,"values")).Select(v=>(OptionSetValue)Decode(v)).ToList());
   case "EntityReference":{var r=new EntityReference(Str(m,"logicalName"),Guid.Parse(Str(m,"id"))) {Name=Get(m,"name") as string,RowVersion=Get(m,"rowVersion") as string};foreach(var p in Map(Get(m,"keyAttributes")))r.KeyAttributes[p.Key]=Decode(p.Value);return r;}
   case "EntityReferenceCollection":return new EntityReferenceCollection(Array(Get(m,"values")).Select(v=>(EntityReference)Decode(v)).ToList());
   case "Relationship":{var relationship=new Relationship(Str(m,"schemaName"));if(Get(m,"primaryEntityRole")!=null)relationship.PrimaryEntityRole=(EntityRole)Enum.Parse(typeof(EntityRole),Str(m,"primaryEntityRole"));return relationship;}
   case "AliasedValue":return new AliasedValue(Str(m,"entityLogicalName"),Str(m,"attributeLogicalName"),Decode(Get(m,"value")));
   case "Entity":{var e=new Entity(Str(m,"logicalName"),Guid.Parse(Str(m,"id",Guid.Empty.ToString())));foreach(var p in Map(Get(m,"attributes")))e[p.Key]=Decode(p.Value);foreach(var p in Map(Get(m,"formattedValues")))e.FormattedValues[p.Key]=Convert.ToString(p.Value);return e;}
   case "EntityCollection":{var entities=Array(Get(m,"entities")).Select(v=>(Entity)Decode(v)).ToList();return new EntityCollection(entities) {MoreRecords=Convert.ToBoolean(Get(m,"moreRecords",false)),PagingCookie=Get(m,"pagingCookie") as string,TotalRecordCount=Convert.ToInt32(Get(m,"totalRecordCount",-1)),EntityName=Get(m,"entityName") as string,MinActiveRowVersion=Get(m,"minActiveRowVersion") as string,TotalRecordCountLimitExceeded=Convert.ToBoolean(Get(m,"totalRecordCountLimitExceeded",false))};}
   case "ParameterCollection":{var p=new ParameterCollection();foreach(var entry in Map(Get(m,"values")))p[entry.Key]=Decode(entry.Value);return p;}
   case "OrganizationResponse":{var name=Str(m,"responseName");if(!new[]{"Create","Update","Delete","Retrieve","RetrieveMultiple","CreateMultiple","UpdateMultiple","Associate","Disassociate"}.Contains(name))throw new NotSupportedException("Unsupported SDK response contract: "+name);var type=typeof(OrganizationResponse).Assembly.GetType("Microsoft.Xrm.Sdk.Messages."+name+"Response",true);var response=(OrganizationResponse)Activator.CreateInstance(type);foreach(var entry in Map(Get(m,"results")))response.Results[entry.Key]=Decode(entry.Value);return response;}
   case "FetchExpression":return new FetchExpression(Str(m,"query"));
   case "ColumnSet":return Columns(m);
   case "ExecutionContext":return ContextProxy(Map(Get(m,"values")).ToDictionary(p=>p.Key,p=>Decode(p.Value)));
   case "EntityImageCollection":return Images(Get(m,"values"));
   case "EntityImageCollectionArray":return Array(Get(m,"values")).Select(v=>(EntityImageCollection)Decode(v)).ToArray();
   case "GuidArray":return Array(Get(m,"values")).Select(v=>v is string?Guid.Parse((string)v):(Guid)Decode(v)).ToArray();
   case "QueryExpression":{var q=new QueryExpression(Str(m,"entityName")){ColumnSet=Columns(Get(m,"columnSet")),Criteria=DecodeFilter(Get(m,"criteria")),Distinct=Convert.ToBoolean(Get(m,"distinct",false))};if(Get(m,"topCount")!=null)q.TopCount=Convert.ToInt32(Get(m,"topCount"));if(m.ContainsKey("pageInfo"))q.PageInfo=DecodePaging(q.PageInfo,Get(m,"pageInfo"));foreach(var link in Array(Get(m,"linkEntities")))q.LinkEntities.Add((LinkEntity)Decode(link));foreach(var item in Array(Get(m,"orders"))){var o=Map(item);q.Orders.Add(new OrderExpression(Str(o,"attributeName"),Convert.ToBoolean(Get(o,"descending",false))?OrderType.Descending:OrderType.Ascending));}return q;}
   case "LinkEntity":{var link=new LinkEntity(Str(m,"linkFromEntityName"),Str(m,"linkToEntityName"),Str(m,"linkFromAttributeName"),Str(m,"linkToAttributeName"),(JoinOperator)Enum.Parse(typeof(JoinOperator),Str(m,"joinOperator","Inner"))){Columns=Columns(Get(m,"columns")),LinkCriteria=DecodeFilter(Get(m,"linkCriteria")),EntityAlias=Get(m,"entityAlias") as string};foreach(var child in Array(Get(m,"linkEntities")))link.LinkEntities.Add((LinkEntity)Decode(child));foreach(var item in Array(Get(m,"orders"))){var o=Map(item);link.Orders.Add(new OrderExpression(Str(o,"attributeName"),Convert.ToBoolean(Get(o,"descending",false))?OrderType.Descending:OrderType.Ascending));}return link;}
   case "QueryByAttribute":{var q=new QueryByAttribute(Str(m,"entityName")){ColumnSet=Columns(Get(m,"columnSet"))};q.Attributes.AddRange(Array(Get(m,"attributes")).Select(v=>Convert.ToString(v)));q.Values.AddRange(Array(Get(m,"values")).Select(Decode));if(Get(m,"topCount")!=null)q.TopCount=Convert.ToInt32(Get(m,"topCount"));if(m.ContainsKey("pageInfo"))q.PageInfo=DecodePaging(q.PageInfo,Get(m,"pageInfo"));foreach(var item in Array(Get(m,"orders"))){var o=Map(item);q.Orders.Add(new OrderExpression(Str(o,"attributeName"),Convert.ToBoolean(Get(o,"descending",false))?OrderType.Descending:OrderType.Ascending));}return q;}
   case "":return m.ToDictionary(p=>p.Key,p=>Decode(p.Value));
   default:throw new NotSupportedException("Unsupported SDK wire type: "+kind);
  }
 }
 static ColumnSet Columns(object value){var m=Map(value);return Convert.ToBoolean(Get(m,"allColumns",false))?new ColumnSet(true):new ColumnSet(Array(Get(m,"columns")).Select(v=>Convert.ToString(v)).ToArray());}
 static PagingInfo DecodePaging(PagingInfo page,object value){if(value==null)return null;page=page??new PagingInfo();var m=Map(value);page.Count=Convert.ToInt32(Get(m,"count",0));page.PageNumber=Convert.ToInt32(Get(m,"pageNumber",0));page.PagingCookie=Get(m,"pagingCookie") as string;return page;}
 static FilterExpression DecodeFilter(object value){var m=Map(value);var f=new FilterExpression(Str(m,"operatorName","And")=="Or"?LogicalOperator.Or:LogicalOperator.And);foreach(var item in Array(Get(m,"conditions"))){var c=Map(item);var condition=new ConditionExpression(Str(c,"attributeName"),(ConditionOperator)Enum.Parse(typeof(ConditionOperator),Str(c,"operatorName")),Array(Get(c,"values")).Select(Decode).ToArray());condition.EntityName=Get(c,"entityName") as string;f.Conditions.Add(condition);}foreach(var child in Array(Get(m,"filters")))f.Filters.Add(DecodeFilter(child));return f;}
 static object Encode(object value,int depth=0){
  if(depth>64)throw new NotSupportedException("SDK value nesting exceeds 64.");if(value is long)return new Dictionary<string,object>{{"$type","Int64"},{"value",((long)value).ToString(CultureInfo.InvariantCulture)}};if(value is decimal)return new Dictionary<string,object>{{"$type","Decimal"},{"value",((decimal)value).ToString(CultureInfo.InvariantCulture)}};if(value is double){var number=(double)value;if(Double.IsNaN(number)||Double.IsInfinity(number))throw new NotSupportedException("SDK Double requires a finite numeric value.");return new Dictionary<string,object>{{"$type","Double"},{"value",number.ToString("R",CultureInfo.InvariantCulture)}};}if(value==null||value is string||value is bool||value is int)return value;
  if(value is Guid)return new Dictionary<string,object>{{"$type","Guid"},{"value",value.ToString()}};
  if(value is DateTime)return new Dictionary<string,object>{{"$type","DateTime"},{"value",((DateTime)value).ToString("o",CultureInfo.InvariantCulture)}};
  if(value is Money)return new Dictionary<string,object>{{"$type","Money"},{"value",((Money)value).Value.ToString(CultureInfo.InvariantCulture)}};
  if(value is OptionSetValue)return new Dictionary<string,object>{{"$type","OptionSetValue"},{"value",((OptionSetValue)value).Value}};
  if(value is OptionSetValueCollection)return new Dictionary<string,object>{{"$type","OptionSetValueCollection"},{"values",((OptionSetValueCollection)value).Select(v=>Wire(v,depth+1)).ToArray()}};
  if(value is EntityReference){var r=(EntityReference)value;var wire=new Dictionary<string,object>{{"$type","EntityReference"},{"logicalName",r.LogicalName},{"id",r.Id.ToString()},{"name",r.Name}};if(r.KeyAttributes.Count>0)wire["keyAttributes"]=r.KeyAttributes.ToDictionary(p=>p.Key,p=>Wire(p.Value,depth+1));if(r.RowVersion!=null)wire["rowVersion"]=r.RowVersion;return wire;}
  if(value is EntityReferenceCollection)return new Dictionary<string,object>{{"$type","EntityReferenceCollection"},{"values",((EntityReferenceCollection)value).Select(v=>Wire(v,depth+1)).ToArray()}};
  if(value is Relationship){var r=(Relationship)value;return new Dictionary<string,object>{{"$type","Relationship"},{"schemaName",r.SchemaName},{"primaryEntityRole",r.PrimaryEntityRole.HasValue?(object)r.PrimaryEntityRole.Value.ToString():null}};}
  if(value is AliasedValue){var a=(AliasedValue)value;return new Dictionary<string,object>{{"$type","AliasedValue"},{"entityLogicalName",a.EntityLogicalName},{"attributeLogicalName",a.AttributeLogicalName},{"value",Encode(a.Value,depth+1)}};}
  if(value is Entity){var e=(Entity)value;RejectConfigured(e,"KeyAttributes","RelatedEntities","RowVersion");return new Dictionary<string,object>{{"$type","Entity"},{"logicalName",e.LogicalName},{"id",e.Id.ToString()},{"attributes",e.Attributes.ToDictionary(p=>p.Key,p=>Wire(p.Value,depth+1))},{"formattedValues",e.FormattedValues.ToDictionary(p=>p.Key,p=>(object)p.Value)}};}
  if(value is EntityCollection){var e=(EntityCollection)value;var wire=new Dictionary<string,object>{{"$type","EntityCollection"},{"entities",e.Entities.Select(v=>Encode(v,depth+1)).ToArray()},{"moreRecords",e.MoreRecords},{"pagingCookie",e.PagingCookie},{"totalRecordCount",e.TotalRecordCount}};if(e.EntityName!=null)wire["entityName"]=e.EntityName;if(e.MinActiveRowVersion!=null)wire["minActiveRowVersion"]=e.MinActiveRowVersion;if(e.TotalRecordCountLimitExceeded)wire["totalRecordCountLimitExceeded"]=true;return wire;}
  if(value is EntityImageCollection[])return new Dictionary<string,object>{{"$type","EntityImageCollectionArray"},{"values",((EntityImageCollection[])value).Select(v=>Wire(v,depth+1)).ToArray()}};
  if(value is Guid[])return new Dictionary<string,object>{{"$type","GuidArray"},{"values",((Guid[])value).Select(v=>v.ToString()).ToArray()}};
  if(value is EntityImageCollection)return new Dictionary<string,object>{{"$type","EntityImageCollection"},{"values",((EntityImageCollection)value).ToDictionary(p=>p.Key,p=>Wire(p.Value,depth+1))}};
  if(value is IPluginExecutionContext){var proxy=RemotingServices.GetRealProxy(value) as InterfaceProxy;if(proxy==null||proxy.Data==null)throw new NotSupportedException("Unbound ParentContext implementation.");return EncodeContext(proxy.Data,depth+1);}
  if(value is ParameterCollection)return new Dictionary<string,object>{{"$type","ParameterCollection"},{"values",((ParameterCollection)value).ToDictionary(p=>p.Key,p=>Wire(p.Value,depth+1))}};
  if(value is ColumnSet){var c=(ColumnSet)value;RejectConfigured(c,"AttributeExpressions");return new {allColumns=c.AllColumns,columns=c.Columns.ToArray()};}
  if(value is FetchExpression)return new Dictionary<string,object>{{"$type","FetchExpression"},{"query",((FetchExpression)value).Query}};
  if(value is QueryByAttribute){var q=(QueryByAttribute)value;return new Dictionary<string,object>{{"$type","QueryByAttribute"},{"entityName",q.EntityName},{"columnSet",Encode(q.ColumnSet)},{"attributes",q.Attributes.ToArray()},{"values",q.Values.Select(v=>Wire(v)).ToArray()},{"topCount",q.TopCount},{"orders",Orders(q.Orders)},{"pageInfo",Paging(q.PageInfo)}};}
  if(value is QueryExpression){var q=(QueryExpression)value;RejectConfigured(q,"NoLock","QueryHints","ForceSeek","DataSource","SubQueryExpression");return new Dictionary<string,object>{{"$type","QueryExpression"},{"linkEntities",q.LinkEntities.Select(v=>Encode(v,depth+1)).ToArray()},{"entityName",q.EntityName},{"columnSet",Encode(q.ColumnSet)},{"criteria",Filter(q.Criteria)},{"orders",Orders(q.Orders)},{"topCount",q.TopCount},{"distinct",q.Distinct},{"pageInfo",Paging(q.PageInfo)}};}
  if(value is LinkEntity){var link=(LinkEntity)value;RejectConfigured(link,"ForceSeek");return new Dictionary<string,object>{{"$type","LinkEntity"},{"linkFromEntityName",link.LinkFromEntityName},{"linkToEntityName",link.LinkToEntityName},{"linkFromAttributeName",link.LinkFromAttributeName},{"linkToAttributeName",link.LinkToAttributeName},{"joinOperator",link.JoinOperator.ToString()},{"entityAlias",link.EntityAlias},{"columns",Encode(link.Columns,depth+1)},{"linkCriteria",Filter(link.LinkCriteria)},{"orders",Orders(link.Orders)},{"linkEntities",link.LinkEntities.Select(v=>Encode(v,depth+1)).ToArray()}};}
  if(value is OrganizationRequest){var r=(OrganizationRequest)value;RejectConfigured(r,"RequestId");return new Dictionary<string,object>{{"$type","OrganizationRequest"},{"requestName",r.RequestName},{"parameters",Encode(r.Parameters)}};}
  if(value is byte[])return new Dictionary<string,object>{{"$type","Bytes"},{"value",Convert.ToBase64String((byte[])value)}};
  if(value is System.Array&&value.GetType()!=typeof(object[])){var array=(System.Array)value;var element=array.GetType().GetElementType();var primitive=new[]{typeof(string),typeof(int),typeof(bool),typeof(long),typeof(decimal),typeof(double),typeof(DateTime)}.Contains(element);var sdk=new[]{typeof(Entity),typeof(EntityReference),typeof(OptionSetValue),typeof(Money),typeof(EntityCollection),typeof(QueryExpression),typeof(string[])}.Contains(element);if(array.Rank!=1||!primitive&&!sdk)throw new NotSupportedException("Unsupported SDK array type: "+array.GetType().FullName);return new Dictionary<string,object>{{"$type",primitive?"PrimitiveArray":"SdkArray"},{"elementType",element.Name},{"values",array.Cast<object>().Select(v=>Wire(v,depth+1)).ToArray()}};}
  if(value is IEnumerable)return ((IEnumerable)value).Cast<object>().Select(v=>Wire(v,depth+1)).ToArray();
  throw new NotSupportedException("Unsupported SDK value type: "+value.GetType().FullName);
 }
 static object Wire(object value,int depth=0){return value is Guid?new Dictionary<string,object>{{"$type","Guid"},{"value",value.ToString()}}:Encode(value,depth);}
 static void RejectConfigured(object value,params string[] names){foreach(var name in names){var property=value.GetType().GetProperty(name);if(property==null)continue;var item=property.GetValue(value,null);if(item==null||item is bool&&!(bool)item||item is string&&((string)item).Length==0||item is IEnumerable&&!((IEnumerable)item).Cast<object>().Any())continue;throw new NotSupportedException("Unsupported configured SDK property: "+value.GetType().Name+"."+name);}}
 static object Paging(PagingInfo page){if(page==null)return null;RejectConfigured(page,"ReturnTotalRecordCount");return new {count=page.Count,pageNumber=page.PageNumber,pagingCookie=page.PagingCookie};}
 static object Orders(IEnumerable<OrderExpression> orders){return orders.Select(o=>{RejectConfigured(o,"EntityName","Alias");return new {attributeName=o.AttributeName,descending=o.OrderType==OrderType.Descending};}).ToArray();}
 static object Filter(FilterExpression filter){RejectConfigured(filter,"AnyAllFilterLinkEntity","FilterHint","IsQuickFindFilter");return new {operatorName=filter.FilterOperator.ToString(),conditions=filter.Conditions.Select(c=>{RejectConfigured(c,"CompareColumns");return new {attributeName=c.AttributeName,entityName=c.EntityName,operatorName=c.Operator.ToString(),values=c.Values.Select(v=>Wire(v)).ToArray()};}).ToArray(),filters=filter.Filters.Select(Filter).ToArray()};}
 static object EncodeContext(Dictionary<string,object> context,int depth=0){return new Dictionary<string,object>{{"$type","ExecutionContext"},{"values",context.ToDictionary(p=>p.Key,p=>Wire(p.Value,depth+1))}};}
 static object Rpc(string method,object[] args,Guid? user){Send(new {kind="rpc",method=method,arguments=args.Select(a=>Wire(a)).ToArray(),userId=user.HasValue?(object)user.Value.ToString():null,parentContext=EncodeContext(CurrentContext)});var answer=Map(Json.DeserializeObject(Console.ReadLine()??"{}"));if(Str(answer,"kind")!="rpc-answer")throw new InvalidOperationException("Invalid SDK RPC answer.");var error=Map(Get(answer,"error"));if(error.Count>0){var fault=Map(Get(error,"organizationServiceFault"));if(fault.Count>0){var detail=new OrganizationServiceFault {ErrorCode=Convert.ToInt32(Get(fault,"errorCode")),Message=Str(fault,"message"),Timestamp=DateTime.Parse(Str(fault,"timestamp"),CultureInfo.InvariantCulture,DateTimeStyles.RoundtripKind)};foreach(var entry in Map(Get(fault,"errorDetails")))detail.ErrorDetails[entry.Key]=Decode(entry.Value);throw new FaultException<OrganizationServiceFault>(detail,new FaultReason(detail.Message));}throw new NotSupportedException("Local SDK callback cannot supply a native OrganizationServiceFault for "+Str(error,"code")+": "+Str(error,"message"));}return Decode(Get(answer,"value"));}
 sealed class InterfaceProxy:RealProxy {
  readonly Func<IMethodCallMessage,object> Handler;
  public Dictionary<string,object> Data;
  public InterfaceProxy(Type type,Func<IMethodCallMessage,object> handler):base(type){Handler=handler;}
  public override IMessage Invoke(IMessage message){var call=(IMethodCallMessage)message;try{return new ReturnMessage(Handler(call),null,0,call.LogicalCallContext,call);}catch(Exception e){return new ReturnMessage(e,call);}}
 }
 static object Proxy(Type type,Func<IMethodCallMessage,object> handler){return new InterfaceProxy(type,handler).GetTransparentProxy();}
 static object ContextProxy(Dictionary<string,object> context){var proxy=new InterfaceProxy(typeof(IPluginExecutionContext4),call=>{if(call.MethodName.StartsWith("get_")){object value;if(!context.TryGetValue(call.MethodName.Substring(4),out value))throw new NotSupportedException("Unconfigured execution context property: "+call.MethodName.Substring(4));return value;}if(call.MethodName.StartsWith("set_")){context[call.MethodName.Substring(4)]=call.Args[0];return null;}throw new NotSupportedException("Unsupported context method: "+call.MethodName);});proxy.Data=context;return proxy.GetTransparentProxy();}
 sealed class Services:IServiceProvider {
  readonly Dictionary<string,object> Context;
  public Services(Dictionary<string,object> context){Context=context;}
  public object GetService(Type type){
   if(type.IsInterface&&typeof(IExecutionContext).IsAssignableFrom(type)&&type.IsAssignableFrom(typeof(IPluginExecutionContext4)))return ContextProxy(Context);
   if(type==typeof(ITracingService))return Proxy(type,call=>{if(call.MethodName!="Trace")throw new NotSupportedException("Unsupported tracing method.");var args=(object[])call.Args[1];Send(new {kind="trace",message=String.Format(CultureInfo.InvariantCulture,(string)call.Args[0],args)});return null;});
   if(type==typeof(IOrganizationServiceFactory))return Proxy(type,call=>{if(call.MethodName!="CreateOrganizationService")throw new NotSupportedException("Unsupported factory method.");Guid? user=(Guid?)call.Args[0];return Proxy(typeof(IOrganizationService),c=>Rpc(c.MethodName,c.Args,user));});
   throw new NotSupportedException("Unconfigured service: "+type.FullName);
  }
 }
 static EntityImageCollection Images(object value){var result=new EntityImageCollection();foreach(var pair in Map(value))result[pair.Key]=(Entity)Decode(pair.Value);return result;}
 public static int Main(){
  Output=Console.Out;Console.SetOut(TextWriter.Null);
  try{
   var input=Map(Json.DeserializeObject(Console.ReadLine()??"{}"));var context=Map(Get(input,"context")).ToDictionary(p=>p.Key,p=>Decode(p.Value));context["InputParameters"]=Decode(Get(input,"inputParameters"));context["OutputParameters"]=Decode(Get(input,"outputParameters"));context["SharedVariables"]=Decode(Get(input,"sharedVariables"));context["PreEntityImages"]=Images(Get(input,"preImages"));context["PostEntityImages"]=Images(Get(input,"postImages"));
   CurrentContext=context;var assembly=Assembly.LoadFrom(Str(input,"assembly"));var expected=Str(input,"expectedAssemblyName");if(expected.Length>0&&assembly.GetName().Name!=expected)throw new NotSupportedException("CLR assembly identity differs from the exported registration.");var type=assembly.GetType(Str(input,"typeName"),true);if(!typeof(IPlugin).IsAssignableFrom(type))throw new NotSupportedException("The configured original type does not implement IPlugin.");
   object plugin;var ctor=type.GetConstructor(new[]{typeof(string),typeof(string)});if(ctor!=null)plugin=ctor.Invoke(new object[]{Get(input,"unsecureConfiguration"),Get(input,"secureConfiguration")});else{ctor=type.GetConstructor(new[]{typeof(string)});plugin=ctor!=null?ctor.Invoke(new object[]{Get(input,"unsecureConfiguration")}):Activator.CreateInstance(type);}
   ((IPlugin)plugin).Execute(new Services(context));var parameters=(ParameterCollection)context["InputParameters"];Send(new {kind="result",target=parameters.Contains("Target")?Wire(parameters["Target"]):null,inputParameters=Wire(parameters),outputParameters=Wire(context["OutputParameters"]),sharedVariables=Wire(context["SharedVariables"]),assemblyFullName=type.Assembly.FullName,sdkFullName=typeof(IPlugin).Assembly.FullName});return 0;
  }catch(Exception cause){while(cause is TargetInvocationException&&cause.InnerException!=null)cause=cause.InnerException;var plugin=cause as InvalidPluginExecutionException;Send(new {kind="failure",code=cause is NotSupportedException?"LocalPluginSdkUnsupported":"PluginValidation",message=cause.Message,exceptionType=cause.GetType().FullName,errorCode=plugin==null?(object)null:plugin.ErrorCode,operationStatus=plugin==null?null:plugin.Status.ToString(),exceptionDetails=plugin==null?null:plugin.ExceptionDetails});return 1;}
 }
}
