// SDK gate: Microsoft.PowerPlatform.Dataverse.Client 1.2.27 (ServiceClient) against the simulated Dataverse API.
// Connects through the token-provider constructor on http://127.0.0.1 (port 80: ServiceClient drops the port).
// Prints one JSON line per step. Env: SIM_ORG (simulator origin), SIM_ORG_ID (expected org id), SIM_TOKEN (bearer).
// Exit 0 when every step is ok.
using System.Net.Http;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Crm.Sdk.Messages;
using Microsoft.PowerPlatform.Dataverse.Client;

var org = Environment.GetEnvironmentVariable("SIM_ORG") ?? throw new InvalidOperationException("SIM_ORG is not set");
var expectedOrgId = Environment.GetEnvironmentVariable("SIM_ORG_ID") ?? throw new InvalidOperationException("SIM_ORG_ID is not set");
var token = Environment.GetEnvironmentVariable("SIM_TOKEN") ?? throw new InvalidOperationException("SIM_TOKEN is not set");

var allOk = true;

void Report(string step, bool ok, string detail)
{
    Console.WriteLine(JsonSerializer.Serialize(new { step, ok, detail }));
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

ServiceClient client;
try
{
    client = new ServiceClient(new Uri(org), async resource => await Task.FromResult(token), useUniqueInstance: true);
    Report("construct", client.IsReady, $"IsReady={client.IsReady}");
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

// SOAP path: the simulator answers a text/xml fault. A clean fault exception is the expected outcome.
try
{
    var response = client.Execute(new WhoAmIRequest());
    Report("soap_whoami", false, $"unexpectedly succeeded: {response.GetType().FullName}");
}
catch (Exception ex)
{
    var chain = new List<Exception>();
    for (var e = ex; e is not null; e = e.InnerException) chain.Add(e);
    var types = string.Join(" -> ", chain.Select(e => e.GetType().FullName));
    var messages = string.Join(" | ", chain.Select(e => e.Message));
    var isProtocol = chain.Any(e => e.GetType().Name == "ProtocolException" && e.Message.Contains("content type", StringComparison.OrdinalIgnoreCase));
    var isFault = chain.Any(e => e.GetType().Name.StartsWith("FaultException", StringComparison.Ordinal) || e.GetType().Name == "CommunicationException");
    var mentionsSoap = chain.Any(e => e.Message.Contains("SOAP", StringComparison.OrdinalIgnoreCase) || e.Message.Contains("not simulated", StringComparison.OrdinalIgnoreCase));
    var ok = !isProtocol && (isFault || mentionsSoap);
    Report("soap_whoami", ok, $"types={types} messages={Truncate(messages)}");
}

client.Dispose();
return allOk ? 0 : 1;
