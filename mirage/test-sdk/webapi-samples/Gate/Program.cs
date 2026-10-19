// SDK gate: Microsoft's WebAPIService sample library (PowerApps-Samples, pinned in ../PINNED_COMMIT.txt)
// replaying its request shapes against the simulated Dataverse API. Prints one JSON line per step.
// Env: SIM_ORG (simulator origin), SIM_TOKEN (bearer). Exit 0 when every step is ok.
using System.Net;
using System.Text.Json;
using Newtonsoft.Json.Linq;
using PowerApps.Samples;
using PowerApps.Samples.Batch;
using PowerApps.Samples.Messages;

var org = Environment.GetEnvironmentVariable("SIM_ORG") ?? throw new InvalidOperationException("SIM_ORG is not set");
var token = Environment.GetEnvironmentVariable("SIM_TOKEN") ?? throw new InvalidOperationException("SIM_TOKEN is not set");

var failedRequired = false;

void Report(string step, bool ok, string detail)
{
    Console.WriteLine(JsonSerializer.Serialize(new { step, ok, detail }));
    if (!ok) failedRequired = true;
}

string Describe(Exception ex) => ex is ServiceException se
    ? $"HTTP {(int)se.HttpStatusCode} {se.ReasonPhrase}: {Truncate(se.Content)}"
    : $"{ex.GetType().Name}: {ex.Message}";

string Truncate(string? s) => s is null ? "" : s.Length > 600 ? s[..600] + "..." : s;

async Task Step(string name, Func<Task<string>> action)
{
    try { Report(name, true, await action()); }
    catch (Exception ex) { Report(name, false, Describe(ex)); }
}

Service service;
try
{
    service = new Service(new Config
    {
        Url = org,
        GetAccessToken = () => Task.FromResult(token),
        Version = "9.2",
    });
}
catch (Exception ex)
{
    Report("construct", false, Describe(ex));
    return 1;
}

Report("construct", true, $"userId={service.UserId} dop={service.RecommendedDegreeOfParallelism}");

await Step("whoami", async () =>
{
    var response = await service.SendAsync<WhoAmIResponse>(new WhoAmIRequest());
    return $"status={(int)response.StatusCode} userId={response.UserId}";
});

EntityReference? created = null;
var name = "sdk-gate-" + Guid.NewGuid().ToString("N")[..8];

await Step("create", async () =>
{
    var response = await service.SendAsync<CreateResponse>(new CreateRequest("widgets", new JObject { ["name"] = name, ["quantity"] = 1 }));
    created = response.EntityReference ?? throw new InvalidOperationException("no OData-EntityId in response");
    return $"status={(int)response.StatusCode} id={created.Id} path={created.Path}";
});

if (created is null)
{
    Report("retrieve", false, "skipped: create did not return a reference");
    Report("update", false, "skipped: create did not return a reference");
    Report("retrieveMultiple", false, "skipped: create did not return a reference");
    Report("delete", false, "skipped: create did not return a reference");
}
else
{
    var reference = created;

    await Step("retrieve", async () =>
    {
        var response = await service.SendAsync<RetrieveResponse>(new RetrieveRequest(reference, "?$select=name"));
        var body = JObject.Parse(await response.Content.ReadAsStringAsync());
        var got = (string?)body["name"];
        if (got != name) throw new InvalidOperationException($"expected name '{name}', got '{got}'");
        return $"status={(int)response.StatusCode} name={got}";
    });

    await Step("update", async () =>
    {
        var response = await service.SendAsync(new UpdateRequest(reference, new JObject { ["quantity"] = 2 }));
        return $"status={(int)response.StatusCode}";
    });

    await Step("retrieveMultiple", async () =>
    {
        var response = await service.SendAsync<RetrieveMultipleResponse>(new RetrieveMultipleRequest("widgets?$select=name&$top=3"));
        var records = response.Records ?? throw new InvalidOperationException("no value array");
        return $"status={(int)response.StatusCode} rows={records.Count}";
    });

    await Step("delete", async () =>
    {
        var response = await service.SendAsync(new DeleteRequest(reference));
        return $"status={(int)response.StatusCode}";
    });
}

// $batch with one change set; the simulator answers a multipart 200 with changesetresponse parts.
await Step("batch", async () =>
{
    var batch = new BatchRequest(service.BaseAddress)
    {
        ChangeSets = new List<ChangeSet>
        {
            new ChangeSet(new List<HttpRequestMessage>
            {
                new CreateRequest("widgets", new JObject { ["name"] = name + "-a" }),
                new CreateRequest("widgets", new JObject { ["name"] = name + "-b" }),
            }),
        },
    };
    var response = await service.SendAsync(batch);
    return $"status={(int)response.StatusCode}";
});

return failedRequired ? 1 : 0;
