// SDK gate: Microsoft.Identity.Client (MSAL.NET) certificate credential against the simulated Entra authority.
// WithCertificate(cert, sendX5C: true) signs the client assertion (PS256, x5t#S256, x5c) with the per-run key,
// redeems it at https://127.0.0.1:<port>/<tenant> with instance discovery off, then calls WhoAmI over plain HttpClient.
// Prints one JSON line per step; exit 0 when every step is ok.
// Env: SIM_TLS_ORIGIN, SIM_TENANT, SIM_CLIENT_ID, SIM_CERT_PEM, SIM_KEY_PEM, SIM_CA_FINGERPRINT (SHA-256 hex of the server certificate).
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Microsoft.Identity.Client;

static string Env(string name) => Environment.GetEnvironmentVariable(name) ?? throw new InvalidOperationException($"{name} is not set");

var tlsOrigin = Env("SIM_TLS_ORIGIN");
var tenant = Env("SIM_TENANT");
var clientId = Env("SIM_CLIENT_ID");
var caFingerprint = Env("SIM_CA_FINGERPRINT").Replace(":", "");

var allOk = true;
void Report(string step, bool ok, string detail)
{
    Console.WriteLine(JsonSerializer.Serialize(new { step, ok, detail }));
    if (!ok) allOk = false;
}
async Task Step(string name, Func<Task<string>> action)
{
    try { Report(name, true, await action()); }
    catch (Exception ex) { Report(name, false, $"{ex.GetType().FullName}: {ex.Message}"); }
}

// The simulator's self-signed certificate is its own CA: trust exactly that certificate, nothing else.
var handler = new HttpClientHandler
{
    ServerCertificateCustomValidationCallback = (_, serverCert, _, _) =>
        serverCert is not null && string.Equals(serverCert.GetCertHashString(HashAlgorithmName.SHA256), caFingerprint, StringComparison.OrdinalIgnoreCase),
};
var http = new HttpClient(handler);

// CreateFromPem yields an ephemeral key; re-importing through PKCS#12 gives Windows CNG a key it can sign with.
var pem = X509Certificate2.CreateFromPem(Env("SIM_CERT_PEM"), Env("SIM_KEY_PEM"));
var cert = X509CertificateLoader.LoadPkcs12(pem.Export(X509ContentType.Pkcs12), null);

string? token = null;
await Step("token", async () =>
{
    var app = ConfidentialClientApplicationBuilder.Create(clientId)
        .WithAuthority(new Uri($"{tlsOrigin}/{tenant}"))
        .WithInstanceDiscovery(false)
        .WithCertificate(cert, sendX5C: true)
        .WithHttpClientFactory(new Factory(http))
        .Build();
    var result = await app.AcquireTokenForClient(new[] { $"{tlsOrigin}/.default" }).ExecuteAsync();
    token = result.AccessToken;
    var payload = token.Split('.')[1];
    payload = payload.Replace('-', '+').Replace('_', '/').PadRight(payload.Length + (4 - payload.Length % 4) % 4, '=');
    using var claims = JsonDocument.Parse(Convert.FromBase64String(payload));
    var appid = claims.RootElement.GetProperty("appid").GetString();
    var appidacr = claims.RootElement.GetProperty("appidacr").GetString();
    if (!string.Equals(appid, clientId, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException($"appid {appid} is not {clientId}");
    if (appidacr != "2") throw new InvalidOperationException($"appidacr {appidacr} is not 2 (certificate)");
    return $"source={result.AuthenticationResultMetadata.TokenSource} appid={appid} appidacr={appidacr} expiresOn={result.ExpiresOn:O}";
});

await Step("whoami", async () =>
{
    if (token is null) throw new InvalidOperationException("skipped: no token");
    using var request = new HttpRequestMessage(HttpMethod.Get, $"{tlsOrigin}/api/data/v9.2/WhoAmI");
    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
    using var response = await http.SendAsync(request);
    var body = await response.Content.ReadAsStringAsync();
    if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"status={(int)response.StatusCode} body={body}");
    using var who = JsonDocument.Parse(body);
    return $"userId={who.RootElement.GetProperty("UserId").GetGuid()} organizationId={who.RootElement.GetProperty("OrganizationId").GetGuid()}";
});

return allOk ? 0 : 1;

sealed class Factory(HttpClient client) : IMsalHttpClientFactory
{
    public HttpClient GetHttpClient() => client;
}
