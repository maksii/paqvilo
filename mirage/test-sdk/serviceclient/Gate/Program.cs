// SDK gate: Microsoft.PowerPlatform.Dataverse.Client 1.2.27 (ServiceClient) against the simulated Dataverse API.
// Connects through the token-provider constructor on http://127.0.0.1 (port 80: ServiceClient drops the port).
// Two passes, chosen by SIM_USE_WEBAPI. "false" (default) runs CRUD, queries and messages over SOAP
// (/XRMServices/2011/Organization.svc/web) after the raw Web API probes. "true" sets UseWebApi, so CRUD goes over the
// Web API while RetrieveEntityRequest stays on SOAP.
// Prints one JSON line per step. Env: SIM_ORG (simulator origin), SIM_ORG_ID (expected org id), SIM_TOKEN (bearer),
// SIM_IMPERSONATE_ID (a systemuser the simulator knows, for CallerId), SIM_USE_WEBAPI ("true" or "false").
// Exit 0 when every step is ok.
using System.Net.Http;
using System.ServiceModel;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Crm.Sdk.Messages;
using Microsoft.PowerPlatform.Dataverse.Client;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk.Query;

var org = Environment.GetEnvironmentVariable("SIM_ORG") ?? throw new InvalidOperationException("SIM_ORG is not set");
var expectedOrgId = Environment.GetEnvironmentVariable("SIM_ORG_ID") ?? throw new InvalidOperationException("SIM_ORG_ID is not set");
var token = Environment.GetEnvironmentVariable("SIM_TOKEN") ?? throw new InvalidOperationException("SIM_TOKEN is not set");
var impersonateId = Environment.GetEnvironmentVariable("SIM_IMPERSONATE_ID") ?? throw new InvalidOperationException("SIM_IMPERSONATE_ID is not set");
var useWebApi = Environment.GetEnvironmentVariable("SIM_USE_WEBAPI") == "true";
var pass = useWebApi ? "webapi" : "soap";
// Row names carry the pass, so the two passes can share one simulator without colliding.
var tag = $"{pass}-";
// 0x80040217 (the simulator's NotFound code) as the signed 32-bit ErrorCode a FaultException carries.
const int MissingRow = -2147220969;

var allOk = true;

void Report(string step, bool ok, string detail)
{
    Console.WriteLine(JsonSerializer.Serialize(new { pass, step, ok, detail }));
    if (!ok) allOk = false;
}

string Truncate(string? s) => s is null ? "" : s.Length > 600 ? s[..600] + "..." : s;

async Task Step(string name, Func<Task<string>> action)
{
    try { Report(name, true, await action()); }
    catch (Exception ex) { Report(name, false, $"{ex.GetType().FullName}: {Truncate(ex.Message)}"); }
}

// Reads a web response body; the request helpers return HttpResponseMessage-like results.
static async Task<string> BodyOf(HttpResponseMessage response) => await response.Content.ReadAsStringAsync();

Entity Widget(string name)
{
    var entity = new Entity("widget");
    entity["name"] = name;
    return entity;
}

QueryExpression PrefixQuery(string prefix, int page = 0, int count = 0, string? cookie = null)
{
    var query = new QueryExpression("widget") { ColumnSet = new ColumnSet("name") };
    query.Criteria.AddCondition("name", ConditionOperator.BeginsWith, prefix);
    query.Orders.Add(new OrderExpression("name", OrderType.Ascending));
    if (count > 0) query.PageInfo = new PagingInfo { Count = count, PageNumber = page, PagingCookie = cookie };
    return query;
}

ServiceClient client;
try
{
    client = new ServiceClient(new Uri(org), async resource => await Task.FromResult(token), useUniqueInstance: true);
    client.UseWebApi = useWebApi;
    Report("construct", client.IsReady, $"IsReady={client.IsReady} UseWebApi={client.UseWebApi}");
}
catch (Exception ex)
{
    Report("construct", false, $"{ex.GetType().FullName}: {Truncate(ex.Message)}");
    return 1;
}

await Step("org", () =>
{
    // First access to ConnectedOrg* triggers RetrieveCurrentOrganization over the Web API (v9.0).
    var id = client.ConnectedOrgId;
    var detail = $"friendlyName={client.ConnectedOrgFriendlyName} orgId={id} expected={expectedOrgId} version={client.ConnectedOrgVersion}";
    if (!Guid.TryParse(expectedOrgId, out var expected) || id != expected) throw new InvalidOperationException($"org id mismatch: {detail}");
    return Task.FromResult(detail);
});

// Raw Web API probes (ExecuteWebRequest), run in the SOAP pass to show the Web API still answers beside SOAP.
async Task RawWebApi()
{
    string? createdId = null;
    var name = "SC";

    await Step("create", () =>
    {
        var response = client.ExecuteWebRequest(HttpMethod.Post, "widgets", $"{{\"name\":\"{name}\"}}", null, "application/json");
        var entityId = response.Headers.TryGetValues("OData-EntityId", out var values) ? values.FirstOrDefault() : null;
        var match = entityId is null ? null : Regex.Match(entityId, @"\(([0-9a-fA-F-]{36})\)");
        if (match is null || !match.Success) throw new InvalidOperationException($"no GUID in OData-EntityId header: '{entityId}'");
        createdId = match.Groups[1].Value;
        return Task.FromResult($"status={(int)response.StatusCode} id={createdId} entityId={entityId}");
    });

    if (createdId is null)
    {
        Report("retrieve", false, "skipped: create did not return an id");
        Report("update", false, "skipped: create did not return an id");
        Report("query", false, "skipped: create did not return an id");
        Report("delete", false, "skipped: create did not return an id");
    }
    else
    {
        var id = createdId;

        await Step("retrieve", async () =>
        {
            var response = client.ExecuteWebRequest(HttpMethod.Get, $"widgets({id})?$select=name", "", null);
            var body = JsonDocument.Parse(await BodyOf(response));
            var got = body.RootElement.GetProperty("name").GetString();
            if (got != name) throw new InvalidOperationException($"expected name '{name}', got '{got}'");
            return $"status={(int)response.StatusCode} name={got}";
        });

        await Step("update", async () =>
        {
            var response = client.ExecuteWebRequest(HttpMethod.Patch, $"widgets({id})", "{\"name\":\"SC-updated\"}", null, "application/json");
            return $"status={(int)response.StatusCode}";
        });

        await Step("query", async () =>
        {
            var response = client.ExecuteWebRequest(HttpMethod.Get, "widgets?$select=name&$top=2", "", null);
            var body = JsonDocument.Parse(await BodyOf(response));
            var rows = body.RootElement.GetProperty("value").GetArrayLength();
            if (rows < 1 || rows > 2) throw new InvalidOperationException($"expected 1 to 2 rows, got {rows}");
            return $"status={(int)response.StatusCode} rows={rows}";
        });

        await Step("delete", () =>
        {
            var response = client.ExecuteWebRequest(HttpMethod.Delete, $"widgets({id})", "", null);
            return Task.FromResult($"status={(int)response.StatusCode}");
        });
    }

    await Step("whoami_webapi", async () =>
    {
        var response = client.ExecuteWebRequest(HttpMethod.Get, "WhoAmI", "", null);
        var body = JsonDocument.Parse(await BodyOf(response));
        var userId = body.RootElement.GetProperty("UserId").GetString();
        return $"status={(int)response.StatusCode} userId={userId}";
    });
}

// SDK CRUD on the invented widget table: over SOAP or the Web API, depending on client.UseWebApi.
async Task Crud(string step)
{
    await Step(step, () =>
    {
        var id = client.Create(Widget($"{tag}CRUD"));
        if (id == Guid.Empty) throw new InvalidOperationException("Create returned Guid.Empty");
        var before = client.Retrieve("widget", id, new ColumnSet("name")).GetAttributeValue<string>("name");
        client.Update(new Entity("widget", id) { ["name"] = $"{tag}CRUD-2" });
        var after = client.Retrieve("widget", id, new ColumnSet("name")).GetAttributeValue<string>("name");
        client.Delete("widget", id);
        if (before != $"{tag}CRUD" || after != $"{tag}CRUD-2") throw new InvalidOperationException($"retrieve/update mismatch: '{before}' then '{after}'");
        return Task.FromResult($"id={id} created='{before}' updated='{after}' deleted=true");
    });
}

async Task QueryPaging()
{
    await Step("soap_query_paging", () =>
    {
        for (var i = 1; i <= 5; i++) client.Create(Widget($"{tag}PAGE-{i:00}"));
        var first = client.RetrieveMultiple(PrefixQuery($"{tag}PAGE-", 1, 2));
        var second = client.RetrieveMultiple(PrefixQuery($"{tag}PAGE-", 2, 2, first.PagingCookie));
        var names = first.Entities.Concat(second.Entities).Select(e => e.GetAttributeValue<string>("name")).ToList();
        var expected = new[] { 1, 2, 3, 4 }.Select(i => $"{tag}PAGE-{i:00}").ToList();
        if (first.Entities.Count != 2 || !first.MoreRecords) throw new InvalidOperationException($"page 1: {first.Entities.Count} rows, MoreRecords={first.MoreRecords}");
        if (second.Entities.Count != 2) throw new InvalidOperationException($"page 2: {second.Entities.Count} rows");
        if (!names.SequenceEqual(expected)) throw new InvalidOperationException($"pages returned [{string.Join(", ", names)}]");
        return Task.FromResult($"pages=2 rows={names.Count} moreOnPage1={first.MoreRecords} cookie={(first.PagingCookie is null ? "none" : "set")}");
    });
}

async Task Fetch()
{
    await Step("soap_fetch", () =>
    {
        client.Create(Widget($"{tag}FETCH-A"));
        client.Create(Widget($"{tag}FETCH-B"));
        var fetch = new FetchExpression($"<fetch><entity name='widget'><attribute name='name' /><filter><condition attribute='name' operator='like' value='{tag}FETCH-%' /></filter><order attribute='name' /></entity></fetch>");
        var names = client.RetrieveMultiple(fetch).Entities.Select(e => e.GetAttributeValue<string>("name")).ToList();
        if (!names.SequenceEqual(new[] { $"{tag}FETCH-A", $"{tag}FETCH-B" })) throw new InvalidOperationException($"fetch returned [{string.Join(", ", names)}]");
        return Task.FromResult($"rows={names.Count}");
    });
}

async Task Associate()
{
    await Step("soap_associate", () =>
    {
        var widgetId = client.Create(Widget($"{tag}ASSOC"));
        var gadgetId = client.Create(new Entity("gadget") { ["name"] = $"{tag}ASSOC-G" });
        client.Associate("widget", widgetId, new Relationship("widget_gadgets"), new EntityReferenceCollection { new EntityReference("gadget", gadgetId) });
        var linked = client.Retrieve("gadget", gadgetId, new ColumnSet("widgetid")).GetAttributeValue<EntityReference>("widgetid");
        if (linked?.Id != widgetId) throw new InvalidOperationException($"gadget.widgetid is {linked?.Id}, expected {widgetId}");
        return Task.FromResult($"widget={widgetId} gadget={gadgetId} linked=true");
    });
}

async Task ExecuteMultipleContinue()
{
    await Step("soap_execute_multiple", () =>
    {
        var response = (ExecuteMultipleResponse)client.Execute(new ExecuteMultipleRequest
        {
            Requests = new OrganizationRequestCollection
            {
                new CreateRequest { Target = Widget($"{tag}EM-1") },
                new DeleteRequest { Target = new EntityReference("widget", Guid.NewGuid()) },
                new CreateRequest { Target = Widget($"{tag}EM-3") },
            },
            Settings = new ExecuteMultipleSettings { ContinueOnError = true, ReturnResponses = true },
        });
        var items = response.Responses.OrderBy(r => r.RequestIndex).ToList();
        if (!response.IsFaulted || items.Count != 3) throw new InvalidOperationException($"IsFaulted={response.IsFaulted} items={items.Count}");
        if (items[0].Response is not CreateResponse || items[2].Response is not CreateResponse) throw new InvalidOperationException("the creates around the failing item did not both succeed");
        if (items[1].Fault?.ErrorCode != MissingRow) throw new InvalidOperationException($"item 1 ErrorCode={items[1].Fault?.ErrorCode}, expected {MissingRow}");
        return Task.FromResult($"items={items.Count} faultedIndex=1 errorCode={items[1].Fault.ErrorCode} creates=2");
    });
}

async Task ExecuteTransactionRollback()
{
    await Step("soap_execute_transaction", () =>
    {
        try
        {
            client.Execute(new ExecuteTransactionRequest
            {
                Requests = new OrganizationRequestCollection
                {
                    new CreateRequest { Target = Widget($"{tag}TX-1") },
                    new CreateRequest { Target = Widget($"{tag}TX-2") },
                    new DeleteRequest { Target = new EntityReference("widget", Guid.NewGuid()) },
                },
                ReturnResponses = true,
            });
        }
        catch (FaultException<OrganizationServiceFault> fault) when (fault.Detail.ErrorCode == MissingRow)
        {
            var survivors = client.RetrieveMultiple(PrefixQuery($"{tag}TX-")).Entities.Count;
            if (survivors != 0) throw new InvalidOperationException($"{survivors} rows survived the rolled-back transaction");
            return Task.FromResult($"fault ErrorCode={fault.Detail.ErrorCode} survivors=0");
        }
        throw new InvalidOperationException($"ExecuteTransaction with a missing-row delete did not fault with ErrorCode {MissingRow}");
    });
}

async Task WhoAmI()
{
    await Step("soap_whoami", () =>
    {
        var who = (WhoAmIResponse)client.Execute(new WhoAmIRequest());
        if (who.UserId == Guid.Empty || who.OrganizationId.ToString() != expectedOrgId) throw new InvalidOperationException($"userId={who.UserId} orgId={who.OrganizationId}");
        return Task.FromResult($"userId={who.UserId} businessUnitId={who.BusinessUnitId} orgId={who.OrganizationId}");
    });
}

async Task CallerIdImpersonation()
{
    await Step("soap_callerid", () =>
    {
        var impersonated = Guid.Parse(impersonateId);
        var self = ((WhoAmIResponse)client.Execute(new WhoAmIRequest())).UserId;
        client.CallerId = impersonated;
        try
        {
            var who = (WhoAmIResponse)client.Execute(new WhoAmIRequest());
            if (who.UserId != impersonated) throw new InvalidOperationException($"WhoAmI under CallerId returned {who.UserId}, expected {impersonated}");
            return Task.FromResult($"caller={self} impersonated={who.UserId}");
        }
        finally
        {
            client.CallerId = Guid.Empty;
        }
    });
}

async Task MissingRowFault()
{
    await Step("soap_fault_missing", () =>
    {
        try
        {
            client.Retrieve("widget", Guid.NewGuid(), new ColumnSet(true));
        }
        catch (FaultException<OrganizationServiceFault> fault) when (fault.Detail.ErrorCode == MissingRow)
        {
            return Task.FromResult($"ErrorCode={fault.Detail.ErrorCode} message='{Truncate(fault.Detail.Message)}'");
        }
        throw new InvalidOperationException($"Retrieve of a missing row did not fault with ErrorCode {MissingRow}");
    });
}

// Metadata over SOAP: RetrieveEntityRequest. Expected to fail until the simulator wires its SOAP metadata messages in.
async Task RetrieveEntity()
{
    await Step("soap_retrieve_entity", () =>
    {
        var response = (RetrieveEntityResponse)client.Execute(new RetrieveEntityRequest { LogicalName = "widget", EntityFilters = EntityFilters.Entity, RetrieveAsIfPublished = false });
        var meta = response.EntityMetadata;
        var logical = meta.LogicalName;
        var detail = $"logicalName='{logical}' metadataId={meta.MetadataId} primaryId={meta.PrimaryIdAttribute} entitySet={meta.EntitySetName}";
        if (logical != "widget") throw new InvalidOperationException($"RetrieveEntity returned logicalName '{logical}': {detail}");
        return Task.FromResult(detail);
    });
}

// Attribute metadata over SOAP: the primary name is a StringAttributeMetadata, and the widget's picklist column is a
// PicklistAttributeMetadata whose OptionSet carries the harness options (1 Standard, 2 Premium).
async Task RetrieveEntityAttributes()
{
    await Step("soap_retrieve_entity_attributes", () =>
    {
        var response = (RetrieveEntityResponse)client.Execute(new RetrieveEntityRequest { LogicalName = "widget", EntityFilters = EntityFilters.Attributes, RetrieveAsIfPublished = false });
        var attributes = response.EntityMetadata.Attributes ?? throw new InvalidOperationException("RetrieveEntity(Attributes) returned no Attributes");
        var primaryName = response.EntityMetadata.PrimaryNameAttribute;
        var primary = attributes.FirstOrDefault(a => a.LogicalName == primaryName) ?? throw new InvalidOperationException($"no attribute for primary name '{primaryName}'");
        if (primary is not StringAttributeMetadata) throw new InvalidOperationException($"primary name '{primaryName}' is {primary.GetType().Name}, expected StringAttributeMetadata");
        var picklist = attributes.OfType<PicklistAttributeMetadata>().FirstOrDefault(a => a.LogicalName == "category") ?? throw new InvalidOperationException("no PicklistAttributeMetadata for 'category'");
        var options = picklist.OptionSet?.Options ?? throw new InvalidOperationException("category has no OptionSet");
        var labels = options.Select(o => $"{o.Value}={o.Label?.UserLocalizedLabel?.Label}").ToList();
        if (string.Join(",", labels) != "1=Standard,2=Premium") throw new InvalidOperationException($"category options {string.Join(",", labels)}");
        return Task.FromResult($"attributes={attributes.Length} primary={primary.LogicalName}({primary.GetType().Name}) picklist={picklist.LogicalName} options={string.Join(",", labels)}");
    });
}

if (useWebApi)
{
    await Crud("webapi_crud");
    await RetrieveEntity();
    await RetrieveEntityAttributes();
}
else
{
    await RawWebApi();
    await Crud("soap_crud");
    await QueryPaging();
    await Fetch();
    await Associate();
    await ExecuteMultipleContinue();
    await ExecuteTransactionRollback();
    await WhoAmI();
    await CallerIdImpersonation();
    await MissingRowFault();
}

client.Dispose();
return allOk ? 0 : 1;
