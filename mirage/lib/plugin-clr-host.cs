// Original Paqvilo host. Project-supplied Microsoft SDK references; no third-party emulator.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.ServiceModel;
using System.Diagnostics;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

public static class PaqviloPluginHost {
 static readonly JavaScriptSerializer Json=new JavaScriptSerializer {MaxJsonLength=4*1024*1024,RecursionLimit=64};
 static TextWriter Output;
 static readonly ConditionalWeakTable<Exception,object> AdapterUnsupported=new ConditionalWeakTable<Exception,object>();
 static readonly object AdapterMarker=new object();
 static NotSupportedException Unsupported(string message){var error=new NotSupportedException(message);AdapterUnsupported.Add(error,AdapterMarker);return error;}
 static bool IsAdapterUnsupported(Exception error){object marker;return AdapterUnsupported.TryGetValue(error,out marker);}

 sealed class InvocationLease {public readonly Dictionary<string,object> Context;public readonly Dictionary<Exception,int> CallbackErrors=new Dictionary<Exception,int>();readonly int ThreadId=Thread.CurrentThread.ManagedThreadId;volatile bool Closed;public InvocationLease(Dictionary<string,object> context){Context=context;}public void Check(){if(Closed)throw Unsupported("The CLR invocation has completed; its retained service or context handle has expired.");if(Thread.CurrentThread.ManagedThreadId!=ThreadId)throw Unsupported("CLR invocation callbacks are not supported on background threads.");}public void Close(){Closed=true;}}
 static Timer ParentWatcher;
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
   case "SdkArray":{var values=Array(Get(m,"values")).Select(Decode);switch(Str(m,"elementType")){case "Entity":return values.Select(v=>(Entity)v).ToArray();case "EntityReference":return values.Select(v=>(EntityReference)v).ToArray();case "OptionSetValue":return values.Select(v=>(OptionSetValue)v).ToArray();case "Money":return values.Select(v=>(Money)v).ToArray();case "EntityCollection":return values.Select(v=>(EntityCollection)v).ToArray();case "QueryExpression":return values.Select(v=>(QueryExpression)v).ToArray();case "String[]":return values.Select(v=>(string[])v).ToArray();default:throw Unsupported("Unsupported SDK array element type: "+Str(m,"elementType"));}}
   case "PrimitiveArray":{var values=Array(Get(m,"values")).Select(Decode);switch(Str(m,"elementType")){case "String":return values.Select(v=>(string)v).ToArray();case "Int32":return values.Select(v=>(int)v).ToArray();case "Boolean":return values.Select(v=>(bool)v).ToArray();case "Int64":return values.Select(v=>(long)v).ToArray();case "Decimal":return values.Select(v=>(decimal)v).ToArray();case "Double":return values.Select(v=>(double)v).ToArray();case "DateTime":return values.Select(v=>(DateTime)v).ToArray();default:throw Unsupported("Unsupported SDK primitive array element type: "+Str(m,"elementType"));}}
   case "Double":{var number=Double.Parse(Str(m,"value"),NumberStyles.Float,CultureInfo.InvariantCulture);if(Double.IsNaN(number)||Double.IsInfinity(number))throw Unsupported("SDK Double requires a finite numeric value.");return number;}
   case "Money":return new Money(Convert.ToDecimal(Get(m,"value"),CultureInfo.InvariantCulture));
   case "OptionSetValue":return new OptionSetValue(Convert.ToInt32(Get(m,"value")));
   case "OptionSetValueCollection":return new OptionSetValueCollection(Array(Get(m,"values")).Select(v=>(OptionSetValue)Decode(v)).ToList());
   case "EntityReference":{var r=new EntityReference(Str(m,"logicalName"),Guid.Parse(Str(m,"id"))) {Name=Get(m,"name") as string,RowVersion=Get(m,"rowVersion") as string};foreach(var p in Map(Get(m,"keyAttributes")))r.KeyAttributes[p.Key]=Decode(p.Value);return r;}
   case "EntityReferenceCollection":return new EntityReferenceCollection(Array(Get(m,"values")).Select(v=>(EntityReference)Decode(v)).ToList());
   case "Relationship":{var relationship=new Relationship(Str(m,"schemaName"));if(Get(m,"primaryEntityRole")!=null)relationship.PrimaryEntityRole=(EntityRole)Enum.Parse(typeof(EntityRole),Str(m,"primaryEntityRole"));return relationship;}
   case "AliasedValue":return new AliasedValue(Str(m,"entityLogicalName"),Str(m,"attributeLogicalName"),Decode(Get(m,"value")));
   case "Entity":{var e=new Entity(Str(m,"logicalName"),Guid.Parse(Str(m,"id",Guid.Empty.ToString()))){RowVersion=Get(m,"rowVersion") as string};foreach(var p in Map(Get(m,"attributes")))e[p.Key]=Decode(p.Value);foreach(var p in Map(Get(m,"keyAttributes")))e.KeyAttributes[p.Key]=Decode(p.Value);foreach(var p in Map(Get(m,"formattedValues")))e.FormattedValues[p.Key]=Convert.ToString(p.Value);return e;}
   case "EntityCollection":{var entities=Array(Get(m,"entities")).Select(v=>(Entity)Decode(v)).ToList();return new EntityCollection(entities) {MoreRecords=Convert.ToBoolean(Get(m,"moreRecords",false)),PagingCookie=Get(m,"pagingCookie") as string,TotalRecordCount=Convert.ToInt32(Get(m,"totalRecordCount",-1)),EntityName=Get(m,"entityName") as string,MinActiveRowVersion=Get(m,"minActiveRowVersion") as string,TotalRecordCountLimitExceeded=Convert.ToBoolean(Get(m,"totalRecordCountLimitExceeded",false))};}
   case "ParameterCollection":{var p=new ParameterCollection();foreach(var entry in Map(Get(m,"values")))p[entry.Key]=Decode(entry.Value);return p;}
   case "ConcurrencyBehavior":{var raw=Get(m,"value");if(!(raw is int)||!Enum.IsDefined(typeof(ConcurrencyBehavior),raw))throw Unsupported("Unsupported SDK ConcurrencyBehavior value.");return (ConcurrencyBehavior)(int)raw;}
   case "Dictionary":return Map(Get(m,"values")).ToDictionary(p=>p.Key,p=>Decode(p.Value));
   case "BooleanManagedProperty":{var json=Json.Serialize(new {Value=Convert.ToBoolean(Get(m,"value",false)),CanBeChanged=Convert.ToBoolean(Get(m,"canBeChanged",true)),ManagedPropertyLogicalName=Get(m,"managedPropertyLogicalName") as string});using(var stream=new MemoryStream(System.Text.Encoding.UTF8.GetBytes(json)))return (BooleanManagedProperty)new System.Runtime.Serialization.Json.DataContractJsonSerializer(typeof(BooleanManagedProperty)).ReadObject(stream);}
   case "OrganizationRequest":{var request=Convert.ToBoolean(Get(m,"typed",false))?(OrganizationRequest)Activator.CreateInstance(RequestType(Str(m,"requestName"))):new OrganizationRequest(Str(m,"requestName"));var parameters=Decode(Get(m,"parameters")) as ParameterCollection;if(parameters==null)throw Unsupported("OrganizationRequest requires a ParameterCollection.");request.Parameters=parameters;if(Get(m,"requestId")!=null)request.RequestId=Guid.Parse(Str(m,"requestId"));return request;}
   case "OrganizationResponse":{var name=Str(m,"responseName");if(Convert.ToBoolean(Get(m,"custom",false))){var custom=new OrganizationResponse{ResponseName=name};foreach(var entry in Map(Get(m,"results")))custom.Results[entry.Key]=Decode(entry.Value);return custom;}var type=ResponseType(Str(m,"contract",name));var response=(OrganizationResponse)Activator.CreateInstance(type);response.ResponseName=Get(m,"responseName") as string;foreach(var entry in Map(Get(m,"results")))response.Results[entry.Key]=Decode(entry.Value);return response;}
   case "FetchExpression":return new FetchExpression(Str(m,"query"));
   case "ColumnSet":return Columns(m);
   case "ExecutionContext":return ContextProxy(Map(Get(m,"values")).ToDictionary(p=>p.Key,p=>Decode(p.Value)));
   case "EntityImageCollection":return Images(Get(m,"values"));
   case "EntityImageCollectionArray":return Array(Get(m,"values")).Select(v=>(EntityImageCollection)Decode(v)).ToArray();
   case "GuidArray":return Array(Get(m,"values")).Select(v=>v is string?Guid.Parse((string)v):(Guid)Decode(v)).ToArray();
   case "QueryExpression":{var q=new QueryExpression(Str(m,"entityName")){ColumnSet=m.ContainsKey("columnSet")?Columns(Get(m,"columnSet")):new ColumnSet(false),Criteria=DecodeFilter(Get(m,"criteria")),Distinct=Convert.ToBoolean(Get(m,"distinct",false)),NoLock=Convert.ToBoolean(Get(m,"noLock",false))};SetOptional(q,"QueryHints",Get(m,"queryHints"));SetOptional(q,"DataSource",Get(m,"dataSource"));if(Get(m,"topCount")!=null)q.TopCount=Convert.ToInt32(Get(m,"topCount"));if(m.ContainsKey("pageInfo"))q.PageInfo=DecodePaging(q.PageInfo,Get(m,"pageInfo"));foreach(var link in Array(Get(m,"linkEntities")))q.LinkEntities.Add((LinkEntity)Decode(link));foreach(var item in Array(Get(m,"orders"))){var o=Map(item);q.Orders.Add(DecodeOrder(o));}return q;}
   case "LinkEntity":{var link=new LinkEntity(Str(m,"linkFromEntityName"),Str(m,"linkToEntityName"),Str(m,"linkFromAttributeName"),Str(m,"linkToAttributeName"),(JoinOperator)Enum.Parse(typeof(JoinOperator),Str(m,"joinOperator","Inner"))){Columns=m.ContainsKey("columns")?Columns(Get(m,"columns")):new ColumnSet(false),LinkCriteria=DecodeFilter(Get(m,"linkCriteria")),EntityAlias=Get(m,"entityAlias") as string};foreach(var child in Array(Get(m,"linkEntities")))link.LinkEntities.Add((LinkEntity)Decode(child));foreach(var item in Array(Get(m,"orders"))){var o=Map(item);link.Orders.Add(DecodeOrder(o));}return link;}
   case "QueryByAttribute":{var q=new QueryByAttribute(Str(m,"entityName")){ColumnSet=m.ContainsKey("columnSet")?Columns(Get(m,"columnSet")):new ColumnSet(false)};q.Attributes.AddRange(Array(Get(m,"attributes")).Select(v=>Convert.ToString(v)));q.Values.AddRange(Array(Get(m,"values")).Select(Decode));if(Get(m,"topCount")!=null)q.TopCount=Convert.ToInt32(Get(m,"topCount"));if(m.ContainsKey("pageInfo"))q.PageInfo=DecodePaging(q.PageInfo,Get(m,"pageInfo"));foreach(var item in Array(Get(m,"orders"))){var o=Map(item);q.Orders.Add(DecodeOrder(o));}return q;}
   case "":return m.ToDictionary(p=>p.Key,p=>Decode(p.Value));
   default:throw Unsupported("Unsupported SDK wire type: "+kind);
  }
 }
 static Type RequestType(string name){var response=ResponseType(name);return response.Assembly.GetType(response.FullName.Substring(0,response.FullName.Length-8)+"Request",true);}
 static Type ResponseType(string name){if(!new[]{"Create","Update","Delete","Retrieve","RetrieveMultiple","CreateMultiple","UpdateMultiple","Associate","Disassociate","FetchXmlToQueryExpression","QueryExpressionToFetchXml"}.Contains(name))throw Unsupported("Unsupported SDK response contract: "+name);return name=="FetchXmlToQueryExpression"||name=="QueryExpressionToFetchXml"?Type.GetType("Microsoft.Crm.Sdk.Messages."+name+"Response, Microsoft.Crm.Sdk.Proxy",true):typeof(OrganizationResponse).Assembly.GetType("Microsoft.Xrm.Sdk.Messages."+name+"Response",true);}
 static object Optional(object value,string property){var p=value.GetType().GetProperty(property);return p==null?null:p.GetValue(value,null);}
 static void SetOptional(object value,string property,object setting){if(setting==null)return;var p=value.GetType().GetProperty(property);if(p==null)throw Unsupported("Installed SDK lacks "+property+".");p.SetValue(value,setting,null);}
 static ColumnSet Columns(object value){if(value==null)return null;var m=Map(value);return Convert.ToBoolean(Get(m,"allColumns",false))?new ColumnSet(true):new ColumnSet(Array(Get(m,"columns")).Select(v=>Convert.ToString(v)).ToArray());}
 static PagingInfo DecodePaging(PagingInfo page,object value){if(value==null)return null;page=page??new PagingInfo();var m=Map(value);page.Count=Convert.ToInt32(Get(m,"count",0));page.PageNumber=Convert.ToInt32(Get(m,"pageNumber",0));page.PagingCookie=Get(m,"pagingCookie") as string;page.ReturnTotalRecordCount=Convert.ToBoolean(Get(m,"returnTotalRecordCount",false));return page;}
 static FilterExpression DecodeFilter(object value){var m=Map(value);var f=new FilterExpression(Str(m,"operatorName","And")=="Or"?LogicalOperator.Or:LogicalOperator.And);foreach(var item in Array(Get(m,"conditions"))){var c=Map(item);var condition=new ConditionExpression(Str(c,"attributeName"),(ConditionOperator)Enum.Parse(typeof(ConditionOperator),Str(c,"operatorName")),Array(Get(c,"values")).Select(Decode).ToArray());condition.EntityName=Get(c,"entityName") as string;if(Convert.ToBoolean(Get(c,"compareColumns",false))){var compare=typeof(ConditionExpression).GetProperty("CompareColumns");if(compare==null)throw Unsupported("Installed SDK lacks CompareColumns.");compare.SetValue(condition,true,null);}f.Conditions.Add(condition);}foreach(var child in Array(Get(m,"filters")))f.Filters.Add(DecodeFilter(child));if(Get(m,"filterHint")!=null){var hint=typeof(FilterExpression).GetProperty("FilterHint");if(hint==null)throw Unsupported("Installed SDK lacks FilterHint.");hint.SetValue(f,Str(m,"filterHint"),null);}if(Convert.ToBoolean(Get(m,"isQuickFindFilter",false)))f.IsQuickFindFilter=true;if(Get(m,"anyAllFilterLinkEntity")!=null){var property=typeof(FilterExpression).GetProperty("AnyAllFilterLinkEntity");if(property==null)throw Unsupported("Installed SDK lacks AnyAllFilterLinkEntity.");property.SetValue(f,(LinkEntity)Decode(Get(m,"anyAllFilterLinkEntity")),null);}return f;}
 static object Encode(object value,int depth=0){
  if(depth>64)throw Unsupported("SDK value nesting exceeds 64.");if(value is long)return new Dictionary<string,object>{{"$type","Int64"},{"value",((long)value).ToString(CultureInfo.InvariantCulture)}};if(value is decimal)return new Dictionary<string,object>{{"$type","Decimal"},{"value",((decimal)value).ToString(CultureInfo.InvariantCulture)}};if(value is double){var number=(double)value;if(Double.IsNaN(number)||Double.IsInfinity(number))throw Unsupported("SDK Double requires a finite numeric value.");return new Dictionary<string,object>{{"$type","Double"},{"value",number.ToString("R",CultureInfo.InvariantCulture)}};}if(value==null||value is string||value is bool||value is int)return value;
  if(value is ConcurrencyBehavior){if(!Enum.IsDefined(typeof(ConcurrencyBehavior),value))throw Unsupported("Unsupported SDK ConcurrencyBehavior value.");return new Dictionary<string,object>{{"$type","ConcurrencyBehavior"},{"value",(int)(ConcurrencyBehavior)value}};}
  if(value is Guid)return new Dictionary<string,object>{{"$type","Guid"},{"value",value.ToString()}};
  if(value is DateTime)return new Dictionary<string,object>{{"$type","DateTime"},{"value",((DateTime)value).ToString("o",CultureInfo.InvariantCulture)}};
  if(value is Money)return new Dictionary<string,object>{{"$type","Money"},{"value",((Money)value).Value.ToString(CultureInfo.InvariantCulture)}};
  if(value is OptionSetValue)return new Dictionary<string,object>{{"$type","OptionSetValue"},{"value",((OptionSetValue)value).Value}};
  if(value is OptionSetValueCollection)return new Dictionary<string,object>{{"$type","OptionSetValueCollection"},{"values",((OptionSetValueCollection)value).Select(v=>Wire(v,depth+1)).ToArray()}};
  if(value is EntityReference){var r=(EntityReference)value;var wire=new Dictionary<string,object>{{"$type","EntityReference"},{"logicalName",r.LogicalName},{"id",r.Id.ToString()},{"name",r.Name}};if(r.KeyAttributes.Count>0)wire["keyAttributes"]=r.KeyAttributes.ToDictionary(p=>p.Key,p=>Wire(p.Value,depth+1));if(r.RowVersion!=null)wire["rowVersion"]=r.RowVersion;return wire;}
  if(value is EntityReferenceCollection)return new Dictionary<string,object>{{"$type","EntityReferenceCollection"},{"values",((EntityReferenceCollection)value).Select(v=>Wire(v,depth+1)).ToArray()}};
  if(value is Relationship){var r=(Relationship)value;return new Dictionary<string,object>{{"$type","Relationship"},{"schemaName",r.SchemaName},{"primaryEntityRole",r.PrimaryEntityRole.HasValue?(object)r.PrimaryEntityRole.Value.ToString():null}};}
  if(value is AliasedValue){var a=(AliasedValue)value;return new Dictionary<string,object>{{"$type","AliasedValue"},{"entityLogicalName",a.EntityLogicalName},{"attributeLogicalName",a.AttributeLogicalName},{"value",Encode(a.Value,depth+1)}};}
  if(value is Entity){var e=(Entity)value;RejectConfigured(e,"RelatedEntities");var wire=new Dictionary<string,object>{{"$type","Entity"},{"logicalName",e.LogicalName},{"id",e.Id.ToString()},{"attributes",e.Attributes.ToDictionary(p=>p.Key,p=>Wire(p.Value,depth+1))},{"formattedValues",e.FormattedValues.ToDictionary(p=>p.Key,p=>(object)p.Value)}};if(e.KeyAttributes.Count>0)wire["keyAttributes"]=e.KeyAttributes.ToDictionary(p=>p.Key,p=>Wire(p.Value,depth+1));if(e.RowVersion!=null)wire["rowVersion"]=e.RowVersion;return wire;}
  if(value is EntityCollection){var e=(EntityCollection)value;var wire=new Dictionary<string,object>{{"$type","EntityCollection"},{"entities",e.Entities.Select(v=>Encode(v,depth+1)).ToArray()},{"moreRecords",e.MoreRecords},{"pagingCookie",e.PagingCookie},{"totalRecordCount",e.TotalRecordCount}};if(e.EntityName!=null)wire["entityName"]=e.EntityName;if(e.MinActiveRowVersion!=null)wire["minActiveRowVersion"]=e.MinActiveRowVersion;if(e.TotalRecordCountLimitExceeded)wire["totalRecordCountLimitExceeded"]=true;return wire;}
  if(value is EntityImageCollection[])return new Dictionary<string,object>{{"$type","EntityImageCollectionArray"},{"values",((EntityImageCollection[])value).Select(v=>Wire(v,depth+1)).ToArray()}};
  if(value is Guid[])return new Dictionary<string,object>{{"$type","GuidArray"},{"values",((Guid[])value).Select(v=>v.ToString()).ToArray()}};
  if(value is EntityImageCollection)return new Dictionary<string,object>{{"$type","EntityImageCollection"},{"values",((EntityImageCollection)value).ToDictionary(p=>p.Key,p=>Wire(p.Value,depth+1))}};
  if(value is IPluginExecutionContext){var local=value as LocalContext;if(local==null)throw Unsupported("Unbound ParentContext implementation.");if(local.Lease!=null)local.Lease.Check();return EncodeContext(local.Data,depth+1);}
  if(value is ParameterCollection)return new Dictionary<string,object>{{"$type","ParameterCollection"},{"values",((ParameterCollection)value).ToDictionary(p=>p.Key,p=>Wire(p.Value,depth+1))}};
  if(value is ColumnSet){var c=(ColumnSet)value;RejectConfigured(c,"AttributeExpressions");return new Dictionary<string,object>{{"$type","ColumnSet"},{"allColumns",c.AllColumns},{"columns",c.Columns.ToArray()}};}
  if(value is FetchExpression)return new Dictionary<string,object>{{"$type","FetchExpression"},{"query",((FetchExpression)value).Query}};
  if(value is QueryByAttribute){var q=(QueryByAttribute)value;return new Dictionary<string,object>{{"$type","QueryByAttribute"},{"entityName",q.EntityName},{"columnSet",Encode(q.ColumnSet)},{"attributes",q.Attributes.ToArray()},{"values",q.Values.Select(v=>Wire(v)).ToArray()},{"topCount",q.TopCount},{"orders",Orders(q.Orders)},{"pageInfo",Paging(q.PageInfo)}};}
  if(value is QueryExpression){var q=(QueryExpression)value;RejectConfigured(q,"ForceSeek","SubQueryExpression");return new Dictionary<string,object>{{"$type","QueryExpression"},{"linkEntities",q.LinkEntities.Select(v=>Encode(v,depth+1)).ToArray()},{"entityName",q.EntityName},{"columnSet",Encode(q.ColumnSet)},{"criteria",Filter(q.Criteria)},{"orders",Orders(q.Orders)},{"topCount",q.TopCount},{"distinct",q.Distinct},{"noLock",q.NoLock},{"queryHints",Optional(q,"QueryHints")},{"dataSource",Optional(q,"DataSource")},{"pageInfo",Paging(q.PageInfo)}};}
  if(value is LinkEntity){var link=(LinkEntity)value;RejectConfigured(link,"ForceSeek");return new Dictionary<string,object>{{"$type","LinkEntity"},{"linkFromEntityName",link.LinkFromEntityName},{"linkToEntityName",link.LinkToEntityName},{"linkFromAttributeName",link.LinkFromAttributeName},{"linkToAttributeName",link.LinkToAttributeName},{"joinOperator",link.JoinOperator.ToString()},{"entityAlias",link.EntityAlias},{"columns",Encode(link.Columns,depth+1)},{"linkCriteria",Filter(link.LinkCriteria)},{"orders",Orders(link.Orders)},{"linkEntities",link.LinkEntities.Select(v=>Encode(v,depth+1)).ToArray()}};}
  if(value is OrganizationRequest){var r=(OrganizationRequest)value;var typed=value.GetType()!=typeof(OrganizationRequest);if(typed&&value.GetType()!=RequestType(r.RequestName))throw Unsupported("Unsupported SDK request implementation: "+value.GetType().FullName);return new Dictionary<string,object>{{"$type","OrganizationRequest"},{"requestName",r.RequestName},{"requestId",r.RequestId.HasValue?(object)r.RequestId.Value.ToString():null},{"typed",typed},{"parameters",Encode(r.Parameters)}};}
  if(value is BooleanManagedProperty){var managed=(BooleanManagedProperty)value;return new Dictionary<string,object>{{"$type","BooleanManagedProperty"},{"value",managed.Value},{"canBeChanged",managed.CanBeChanged},{"managedPropertyLogicalName",managed.ManagedPropertyLogicalName}};}
  if(value is OrganizationResponse){var response=(OrganizationResponse)value;var custom=value.GetType()==typeof(OrganizationResponse);var contract=custom?null:value.GetType().Name.EndsWith("Response",StringComparison.Ordinal)?value.GetType().Name.Substring(0,value.GetType().Name.Length-8):null;if(!custom&&(contract==null||value.GetType()!=ResponseType(contract)))throw Unsupported("Unsupported SDK response implementation: "+value.GetType().FullName);return new Dictionary<string,object>{{"$type","OrganizationResponse"},{"responseName",response.ResponseName},{"contract",contract},{"custom",custom},{"results",response.Results.ToDictionary(p=>p.Key,p=>Wire(p.Value,depth+1))}};}
  if(value is IDictionary<string,object>){if(value.GetType()!=typeof(Dictionary<string,object>))throw Unsupported("Unsupported SDK dictionary implementation: "+value.GetType().FullName);var dictionary=(IDictionary<string,object>)value;var entries=dictionary.ToDictionary(p=>p.Key,p=>Wire(p.Value,depth+1));return dictionary.ContainsKey("$type")?new Dictionary<string,object>{{"$type","Dictionary"},{"values",entries}}:entries;}
  if(value is byte[])return new Dictionary<string,object>{{"$type","Bytes"},{"value",Convert.ToBase64String((byte[])value)}};
  if(value is System.Array&&value.GetType()!=typeof(object[])){var array=(System.Array)value;var element=array.GetType().GetElementType();var primitive=new[]{typeof(string),typeof(int),typeof(bool),typeof(long),typeof(decimal),typeof(double),typeof(DateTime)}.Contains(element);var sdk=new[]{typeof(Entity),typeof(EntityReference),typeof(OptionSetValue),typeof(Money),typeof(EntityCollection),typeof(QueryExpression),typeof(string[])}.Contains(element);if(array.Rank!=1||!primitive&&!sdk)throw Unsupported("Unsupported SDK array type: "+array.GetType().FullName);return new Dictionary<string,object>{{"$type",primitive?"PrimitiveArray":"SdkArray"},{"elementType",element.Name},{"values",array.Cast<object>().Select(v=>Wire(v,depth+1)).ToArray()}};}
  if(value is object[])return ((object[])value).Select(v=>Wire(v,depth+1)).ToArray();
  throw Unsupported("Unsupported SDK value type: "+value.GetType().FullName);
 }
 static object Wire(object value,int depth=0){return value is Guid?new Dictionary<string,object>{{"$type","Guid"},{"value",value.ToString()}}:Encode(value,depth);}
 static void RejectConfigured(object value,params string[] names){foreach(var name in names){var property=value.GetType().GetProperty(name);if(property==null)continue;var item=property.GetValue(value,null);if(item==null||item is bool&&!(bool)item||item is string&&((string)item).Length==0||item is IEnumerable&&!((IEnumerable)item).Cast<object>().Any())continue;throw Unsupported("Unsupported configured SDK property: "+value.GetType().Name+"."+name);}}
 static object Paging(PagingInfo page){if(page==null)return null;return new {count=page.Count,pageNumber=page.PageNumber,pagingCookie=page.PagingCookie,returnTotalRecordCount=page.ReturnTotalRecordCount};}
 static OrderExpression DecodeOrder(Dictionary<string,object> value){var order=new OrderExpression(Str(value,"attributeName"),Convert.ToBoolean(Get(value,"descending",false))?OrderType.Descending:OrderType.Ascending);if(Get(value,"entityName")!=null){var property=typeof(OrderExpression).GetProperty("EntityName");if(property==null)throw Unsupported("Installed SDK lacks order EntityName.");property.SetValue(order,Str(value,"entityName"),null);}return order;}
 static object Orders(IEnumerable<OrderExpression> orders){return orders.Select(o=>{RejectConfigured(o,"Alias");var result=new Dictionary<string,object>{{"attributeName",o.AttributeName},{"descending",o.OrderType==OrderType.Descending}};var property=typeof(OrderExpression).GetProperty("EntityName");var entity=property==null?null:property.GetValue(o,null);if(entity!=null)result["entityName"]=entity;return result;}).ToArray();}
 static object Filter(FilterExpression filter){var result=new Dictionary<string,object>{{"operatorName",filter.FilterOperator.ToString()},{"conditions",filter.Conditions.Select(c=>{var comparison=new Dictionary<string,object>{{"attributeName",c.AttributeName},{"entityName",c.EntityName},{"operatorName",c.Operator.ToString()},{"values",c.Values.Select(v=>Wire(v)).ToArray()}};var compare=typeof(ConditionExpression).GetProperty("CompareColumns");if(compare!=null&&Convert.ToBoolean(compare.GetValue(c,null)))comparison["compareColumns"]=true;return comparison;}).ToArray()},{"filters",filter.Filters.Select(Filter).ToArray()}};var hint=typeof(FilterExpression).GetProperty("FilterHint");var hintValue=hint==null?null:hint.GetValue(filter,null);if(hintValue!=null)result["filterHint"]=hintValue;if(filter.IsQuickFindFilter)result["isQuickFindFilter"]=true;var property=typeof(FilterExpression).GetProperty("AnyAllFilterLinkEntity");var link=property==null?null:property.GetValue(filter,null);if(link!=null)result["anyAllFilterLinkEntity"]=Encode(link);return result;}
 static object EncodeContext(Dictionary<string,object> context,int depth=0){return new Dictionary<string,object>{{"$type","ExecutionContext"},{"values",context.ToDictionary(p=>p.Key,p=>Wire(p.Value,depth+1))}};}
 static object Rpc(InvocationLease lease,string method,object[] args,Guid? user){lease.Check();Send(new {kind="rpc",method=method,arguments=args.Select(a=>Wire(a)).ToArray(),userId=user.HasValue?(object)user.Value.ToString():null});var answer=Map(Json.DeserializeObject(Console.ReadLine()??"{}"));lease.Check();if(Str(answer,"kind")!="rpc-answer")throw new InvalidOperationException("Invalid SDK RPC answer.");var error=Map(Get(answer,"error"));if(error.Count>0){if(Str(error,"clrExceptionType")=="System.ArgumentException"&&Str(error,"code")=="LocalPluginTagDuplicate"){var argument=new ArgumentException(Str(error,"message"));lease.CallbackErrors[argument]=unchecked((int)0x80040224);throw argument;}var fault=Map(Get(error,"organizationServiceFault"));if(fault.Count>0){var detail=new OrganizationServiceFault {ErrorCode=Convert.ToInt32(Get(fault,"errorCode")),Message=Str(fault,"message"),Timestamp=DateTime.Parse(Str(fault,"timestamp"),CultureInfo.InvariantCulture,DateTimeStyles.RoundtripKind)};foreach(var entry in Map(Get(fault,"errorDetails")))detail.ErrorDetails[entry.Key]=Decode(entry.Value);throw new FaultException<OrganizationServiceFault>(detail,new FaultReason(detail.Message));}throw Unsupported("Local SDK callback cannot supply a native OrganizationServiceFault for "+Str(error,"code")+": "+Str(error,"message"));}return Decode(Get(answer,"value"));}
 // Native hands plug-ins a concrete context object implementing every context interface of the
 // installed SDK, so GetType, reflection and interface checks behave as they do online.
 static object ContextProxy(Dictionary<string,object> context,InvocationLease lease=null){return new LocalContext(context,lease);}
 sealed class LocalContext:
#if PAQVILO_CONTEXT7
  IPluginExecutionContext7
#else
  IPluginExecutionContext4
#endif
 {
  internal readonly Dictionary<string,object> Data;internal readonly InvocationLease Lease;
  internal LocalContext(Dictionary<string,object> data,InvocationLease lease){Data=data;Lease=lease;}
  T V<T>(string name){if(Lease!=null)Lease.Check();object value;if(!Data.TryGetValue(name,out value))throw Unsupported("Unconfigured execution context property: "+name);return value==null?default(T):(T)value;}
  public int Mode{get{return V<int>("Mode");}}
  public int IsolationMode{get{return V<int>("IsolationMode");}}
  public int Depth{get{return V<int>("Depth");}}
  public string MessageName{get{return V<string>("MessageName");}}
  public string PrimaryEntityName{get{return V<string>("PrimaryEntityName");}}
  public Guid? RequestId{get{return V<Guid?>("RequestId");}}
  public string SecondaryEntityName{get{return V<string>("SecondaryEntityName");}}
  public ParameterCollection InputParameters{get{return V<ParameterCollection>("InputParameters");}}
  public ParameterCollection OutputParameters{get{return V<ParameterCollection>("OutputParameters");}}
  public ParameterCollection SharedVariables{get{return V<ParameterCollection>("SharedVariables");}}
  public Guid UserId{get{return V<Guid>("UserId");}}
  public Guid InitiatingUserId{get{return V<Guid>("InitiatingUserId");}}
  public Guid BusinessUnitId{get{return V<Guid>("BusinessUnitId");}}
  public Guid OrganizationId{get{return V<Guid>("OrganizationId");}}
  public string OrganizationName{get{return V<string>("OrganizationName");}}
  public Guid PrimaryEntityId{get{return V<Guid>("PrimaryEntityId");}}
  public EntityImageCollection PreEntityImages{get{return V<EntityImageCollection>("PreEntityImages");}}
  public EntityImageCollection PostEntityImages{get{return V<EntityImageCollection>("PostEntityImages");}}
  public EntityReference OwningExtension{get{return V<EntityReference>("OwningExtension");}}
  public Guid CorrelationId{get{return V<Guid>("CorrelationId");}}
  public bool IsExecutingOffline{get{return V<bool>("IsExecutingOffline");}}
  public bool IsOfflinePlayback{get{return V<bool>("IsOfflinePlayback");}}
  public bool IsInTransaction{get{return V<bool>("IsInTransaction");}}
  public Guid OperationId{get{return V<Guid>("OperationId");}}
  public DateTime OperationCreatedOn{get{return V<DateTime>("OperationCreatedOn");}}
  public int Stage{get{return V<int>("Stage");}}
  public IPluginExecutionContext ParentContext{get{return V<IPluginExecutionContext>("ParentContext");}}
  public Guid UserAzureActiveDirectoryObjectId{get{return V<Guid>("UserAzureActiveDirectoryObjectId");}}
  public Guid InitiatingUserAzureActiveDirectoryObjectId{get{return V<Guid>("InitiatingUserAzureActiveDirectoryObjectId");}}
  public Guid InitiatingUserApplicationId{get{return V<Guid>("InitiatingUserApplicationId");}}
  public Guid PortalsContactId{get{return V<Guid>("PortalsContactId");}}
  public bool IsPortalsClientCall{get{return V<bool>("IsPortalsClientCall");}}
  public Guid AuthenticatedUserId{get{return V<Guid>("AuthenticatedUserId");}}
  public EntityImageCollection[] PreEntityImagesCollection{get{return V<EntityImageCollection[]>("PreEntityImagesCollection");}}
  public EntityImageCollection[] PostEntityImagesCollection{get{return V<EntityImageCollection[]>("PostEntityImagesCollection");}}
#if PAQVILO_CONTEXT7
  public string InitiatingUserAgent{get{return V<string>("InitiatingUserAgent");}}
  public string EnvironmentId{get{return V<string>("EnvironmentId");}}
  public Guid TenantId{get{return V<Guid>("TenantId");}}
  public bool IsApplicationUser{get{return V<bool>("IsApplicationUser");}}
#endif
 }
 sealed class Services:IServiceProvider {
  readonly Dictionary<string,object> Context;readonly InvocationLease Lease;
  public Services(Dictionary<string,object> context,InvocationLease lease){Context=context;Lease=lease;}
  public object GetService(Type type){Lease.Check();
   if(type.IsInterface&&typeof(IExecutionContext).IsAssignableFrom(type)&&type.IsAssignableFrom(typeof(LocalContext)))return ContextProxy(Context,Lease);
   if(type==typeof(ITracingService))return new LocalTracing(Lease);
   if(type==typeof(IOrganizationServiceFactory))return new LocalServiceFactory(Lease);
   throw Unsupported("Unconfigured service: "+type.FullName);
  }
 }
 // Concrete service objects with the public SDK interfaces the online sandbox objects implement (native corpus
 // 'services': ITracingService; the factory adds IClusterServiceFactory, IProxyTypesAssemblyProvider,
 // IServiceEndpointNotificationService and IDisposable; the service adds IClusterService).
 sealed class LocalTracing:ITracingService {
  readonly InvocationLease Lease;public LocalTracing(InvocationLease lease){Lease=lease;}
  public void Trace(string format,params object[] args){Lease.Check();Send(new {kind="trace",message=String.Format(CultureInfo.InvariantCulture,format,args)});}
 }
 sealed class LocalServiceFactory:IOrganizationServiceFactory,IProxyTypesAssemblyProvider,IServiceEndpointNotificationService,IDisposable
#if PAQVILO_CONTEXT7
  ,IClusterServiceFactory
#endif
 {
  readonly InvocationLease Lease;public LocalServiceFactory(InvocationLease lease){Lease=lease;}
  public Assembly ProxyTypesAssembly{get;set;}
  public IOrganizationService CreateOrganizationService(Guid? userId){Lease.Check();return new LocalOrganizationService(Lease,userId);}
#if PAQVILO_CONTEXT7
  public IClusterService CreateClusterService(Guid? userId){Lease.Check();return new LocalOrganizationService(Lease,userId);}
#endif
  public string Execute(EntityReference serviceEndpoint,IExecutionContext context){Lease.Check();throw Unsupported("Service endpoint notification from a plug-in is not simulated.");}
  public void Dispose(){}
 }
 sealed class LocalOrganizationService:IOrganizationService
#if PAQVILO_CONTEXT7
  ,IClusterService
#endif
 {
  readonly InvocationLease Lease;readonly Guid? User;
  public LocalOrganizationService(InvocationLease lease,Guid? user){Lease=lease;User=user;}
  object Call(string method,object[] args){return Rpc(Lease,method,args,User);}
  public Guid Create(Entity entity){return (Guid)Call("Create",new object[]{entity});}
  public Entity Retrieve(string entityName,Guid id,ColumnSet columnSet){return (Entity)Call("Retrieve",new object[]{entityName,id,columnSet});}
  public void Update(Entity entity){Call("Update",new object[]{entity});}
  public void Delete(string entityName,Guid id){Call("Delete",new object[]{entityName,id});}
  public OrganizationResponse Execute(OrganizationRequest request){return (OrganizationResponse)Call("Execute",new object[]{request});}
  public void Associate(string entityName,Guid entityId,Relationship relationship,EntityReferenceCollection relatedEntities){Call("Associate",new object[]{entityName,entityId,relationship,relatedEntities});}
  public void Disassociate(string entityName,Guid entityId,Relationship relationship,EntityReferenceCollection relatedEntities){Call("Disassociate",new object[]{entityName,entityId,relationship,relatedEntities});}
  public EntityCollection RetrieveMultiple(QueryBase query){return (EntityCollection)Call("RetrieveMultiple",new object[]{query});}
 }
 static EntityImageCollection Images(object value){var result=new EntityImageCollection();foreach(var pair in Map(value))result[pair.Key]=(Entity)Decode(pair.Value);return result;}
 public static int Main(string[] args){
  // An owned host watches the exact parent process incarnation, not just a PID.
  // This also stops CPU-bound plugin code after abrupt Node/process termination.
  if(args.Length==2&&args[0]=="--process-start"){int id;if(!Int32.TryParse(args[1],out id)||id<=0)return 73;try{using(var parent=Process.GetProcessById(id))Console.Write(parent.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture));return 0;}catch{return 73;}}
  bool persistent=args.Length>0&&args[0]=="--persistent";int offset=persistent?1:0;
  if(args.Length!=offset+4||args[offset]!="--parent"||args[offset+2]!="--parent-start")return 73;
  int parentId;long parentStart;if(!Int32.TryParse(args[offset+1],out parentId)||parentId<=0||!Int64.TryParse(args[offset+3],out parentStart)||parentStart<=0)return 73;
  Process owner;try{owner=Process.GetProcessById(parentId);if(owner.StartTime.ToUniversalTime().Ticks!=parentStart||owner.HasExited)return 74;}catch{return 74;}
  ParentWatcher=new Timer(_=>{try{if(owner.HasExited||owner.StartTime.ToUniversalTime().Ticks!=parentStart)Environment.Exit(74);}catch{Environment.Exit(74);}},null,100,100);
  Output=Console.Out;Console.SetOut(TextWriter.Null);
  try{do{var line=Console.ReadLine();if(line==null)return 0;var result=ExecuteLine(line);if(!persistent)return result;}while(true);}finally{ParentWatcher.Dispose();owner.Dispose();}
 }
 static int ExecuteLine(string line){
  InvocationLease lease=null;bool pluginExecuting=false;try{
   var input=Map(Json.DeserializeObject(line));var context=Map(Get(input,"context")).ToDictionary(p=>p.Key,p=>Decode(p.Value));context["InputParameters"]=Decode(Get(input,"inputParameters"));context["OutputParameters"]=Decode(Get(input,"outputParameters"));context["SharedVariables"]=Decode(Get(input,"sharedVariables"));context["PreEntityImages"]=Images(Get(input,"preImages"));context["PostEntityImages"]=Images(Get(input,"postImages"));
   lease=new InvocationLease(context);var assembly=Assembly.LoadFrom(Str(input,"assembly"));var expected=Str(input,"expectedAssemblyName");if(expected.Length>0&&assembly.GetName().Name!=expected)throw Unsupported("CLR assembly identity differs from the exported registration.");var type=assembly.GetType(Str(input,"typeName"),true);if(!typeof(IPlugin).IsAssignableFrom(type))throw Unsupported("The configured original type does not implement IPlugin.");
   object plugin;var ctor=type.GetConstructor(new[]{typeof(string),typeof(string)});if(ctor!=null)plugin=ctor.Invoke(new object[]{Get(input,"unsecureConfiguration"),Get(input,"secureConfiguration")});else{ctor=type.GetConstructor(new[]{typeof(string)});plugin=ctor!=null?ctor.Invoke(new object[]{Get(input,"unsecureConfiguration")}):Activator.CreateInstance(type);}
   pluginExecuting=true;((IPlugin)plugin).Execute(new Services(context,lease));pluginExecuting=false;var parameters=(ParameterCollection)context["InputParameters"];Send(new {kind="result",target=parameters.Contains("Target")?Wire(parameters["Target"]):null,inputParameters=Wire(parameters),outputParameters=Wire(context["OutputParameters"]),sharedVariables=Wire(context["SharedVariables"]),assemblyFullName=type.Assembly.FullName,sdkFullName=typeof(IPlugin).Assembly.FullName});return 0;
  }catch(Exception cause){while(cause is TargetInvocationException&&cause.InnerException!=null)cause=cause.InnerException;var plugin=cause as InvalidPluginExecutionException;var fault=cause as FaultException<OrganizationServiceFault>;var detail=fault==null?null:fault.Detail;int callbackCode=0;bool callback=lease!=null&&lease.CallbackErrors.TryGetValue(cause,out callbackCode);Send(new {kind="failure",duringPluginExecute=pluginExecuting,pluginException=plugin!=null,code=cause is NotSupportedException&&(!pluginExecuting||IsAdapterUnsupported(cause))?"LocalPluginSdkUnsupported":"PluginValidation",message=cause.Message,exceptionType=cause.GetType().FullName,errorCode=plugin!=null?(object)plugin.ErrorCode:detail!=null?(object)detail.ErrorCode:callback?(object)callbackCode:null,operationStatus=plugin==null?null:plugin.Status.ToString(),exceptionDetails=plugin!=null?(object)plugin.ExceptionDetails:detail!=null?(object)detail.ErrorDetails:null});return 1;}finally{if(lease!=null)lease.Close();}
 }
}
