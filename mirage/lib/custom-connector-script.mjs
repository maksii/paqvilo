// C# custom code of a custom connector (script.csx) run through the local .NET SDK
// (https://learn.microsoft.com/connectors/custom-connectors/write-code): a class `Script : ScriptBase` whose
// ExecuteAsync() answers the HttpResponseMessage; Context carries CorrelationId, OperationId, Request and Logger, and
// Context.SendAsync sends a request. The code replaces the backend request and runs within 2 minutes.
//
// One console host per script hash is generated under <state directory>/connector-scripts/<hash>/ (the OS temporary directory
// for a memory-only runtime) and built once with `dotnet build`; later calls reuse the build. Each call starts the host,
// writes the request as one JSON line, answers every Context.SendAsync line through the connector's own sender (connection
// rewrites, pack http fixtures, loopback only) and reads the final response line. Without `dotnet` on PATH nothing is
// generated: available() is false and run() refuses with CONNECTOR_SCRIPT_SDK_MISSING.
//
// Trust: a script is project code that runs with the user's rights, so it runs only when the project registers it, as pack
// modules are registered (AGENTS.md): the connectorScripts setting names the connector and the SHA-256 of its script.csx text
// (scriptHash). Any other script is refused with CONNECTOR_SCRIPT_UNTRUSTED before anything is generated, built or started.
// A trusted host is built and started with a minimal environment (ENV_ALLOWED, never process.env, so no other connection's
// env: secret reaches it) in its folder under the state directory. It is not sandboxed: unlike the platform host (the
// supported namespaces only, .NET Standard 2.0, 2 minutes, 1 MB), it can use any .NET API, read the user's
// files and open its own HttpClient, which is not confined to loopback. The first build restores Newtonsoft.Json and
// Microsoft.Extensions.Logging.Abstractions from nuget.org (or the user's NuGet configuration); offline it fails.
// Assumption: the native host's split of request and response headers. System.Drawing is not referenced (it needs a
// Windows-only package on current .NET).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DataError } from './data-error.mjs';
import { readLocalFileSync } from '../../lense/local-file.mjs';

const sdkCache = new Map();
/** The .NET SDK version of a dotnet command (`dotnet --version`), or null when it is not on PATH. Cached per command. */
export function dotnetSdk(command = 'dotnet') {
  if (!sdkCache.has(command)) {
    let version = null;
    try {
      const answer = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      if (answer.status === 0 && /^\d+\.\d+/.test(answer.stdout.trim())) version = answer.stdout.trim();
    } catch { version = null; }
    sdkCache.set(command, version);
  }
  return sdkCache.get(command);
}
export const SDK_MISSING = 'CONNECTOR_SCRIPT_SDK_MISSING';
export const UNTRUSTED = 'CONNECTOR_SCRIPT_UNTRUSTED';
/** The SHA-256 (hex) of a script's text: the value connectorScripts registers. */
export const scriptHash = text => createHash('sha256').update(String(text), 'utf8').digest('hex');
const untrusted = (connector, script) => new DataError(`${UNTRUSTED}: the custom connector ${connector} runs C# custom code (script.csx, sha256 ${scriptHash(script.text)}) that the project does not trust; a script runs with your user rights only when connectorScripts names { connector: ${connector}, sha256 } of its text.`, 501, 'OperationUnsupported');
// The environment of a script host: these names (case-insensitive) and DOTNET_*/NUGET_* variables only. The build also gets
// the folder variables NuGet resolves its configuration and caches from (dotnet build fails "Value cannot be null (path1)"
// without them on Windows); none of them carries a value of the user's.
const ENV_ALLOWED = /^(?:PATH|SYSTEMROOT|TEMP|TMP|HOME|USERPROFILE|DOTNET_\w*|NUGET_\w*)$/i;
const BUILD_ALLOWED = /^(?:APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\))$/i;
export const hostEnvironment = (source = process.env, { build = false } = {}) => ({
  ...Object.fromEntries(Object.entries(source).filter(([name]) => ENV_ALLOWED.test(name) || build && BUILD_ALLOWED.test(name))), DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' });
const missing = command => new DataError(`${SDK_MISSING}: the custom connector runs C# custom code (script.csx), which needs the .NET SDK; '${command}' is not on PATH.`, 501, 'OperationUnsupported');

// The namespaces the platform supports, as global usings of the generated host (System.Drawing excepted, see above).
const USINGS = ['System', 'System.Collections', 'System.Collections.Generic', 'System.Diagnostics', 'System.IO', 'System.IO.Compression', 'System.Linq', 'System.Net',
  'System.Net.Http', 'System.Net.Http.Headers', 'System.Net.Security', 'System.Security.Authentication', 'System.Security.Cryptography', 'System.Text',
  'System.Text.RegularExpressions', 'System.Threading', 'System.Threading.Tasks', 'System.Web', 'System.Xml', 'System.Xml.Linq', 'Microsoft.Extensions.Logging',
  'Newtonsoft.Json', 'Newtonsoft.Json.Linq'];
const HOST = `
public interface IScriptContext {
  string CorrelationId { get; }
  string OperationId { get; }
  HttpRequestMessage Request { get; }
  ILogger Logger { get; }
  Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken);
}
public abstract class ScriptBase {
  public IScriptContext Context { get; internal set; }
  public CancellationToken CancellationToken { get; internal set; }
  public static StringContent CreateJsonContent(string serializedJson) => new StringContent(serializedJson ?? "", Encoding.UTF8, "application/json");
  public abstract Task<HttpResponseMessage> ExecuteAsync();
}
internal static class Wire {
  static readonly object Gate = new object();
  internal static JObject Read() { var line = Console.In.ReadLine(); if (line == null) throw new IOException("The connector host closed the channel."); return JObject.Parse(line); }
  internal static void Write(JObject value) { lock (Gate) { Console.Out.WriteLine(value.ToString(Newtonsoft.Json.Formatting.None)); Console.Out.Flush(); } }
  internal static HttpRequestMessage Request(JObject r) {
    var message = new HttpRequestMessage(new HttpMethod((string)r["method"]), (string)r["url"]);
    var body = (string)r["body"];
    if (body != null) message.Content = new ByteArrayContent(Convert.FromBase64String(body));
    foreach (var h in (JObject)r["headers"] ?? new JObject()) {
      var value = (string)h.Value;
      if (!message.Headers.TryAddWithoutValidation(h.Key, value) && message.Content != null) message.Content.Headers.TryAddWithoutValidation(h.Key, value);
    }
    return message;
  }
  internal static async Task<JObject> Describe(HttpRequestMessage m) {
    var headers = new JObject();
    foreach (var h in m.Headers) headers[h.Key] = string.Join(",", h.Value);
    byte[] bytes = null;
    if (m.Content != null) { foreach (var h in m.Content.Headers) headers[h.Key] = string.Join(",", h.Value); bytes = await m.Content.ReadAsByteArrayAsync(); }
    return new JObject { ["method"] = m.Method.Method, ["url"] = m.RequestUri?.ToString(), ["headers"] = headers, ["body"] = bytes == null ? null : Convert.ToBase64String(bytes) };
  }
  internal static async Task<JObject> Describe(HttpResponseMessage m) {
    var headers = new JObject();
    foreach (var h in m.Headers) headers[h.Key] = string.Join(",", h.Value);
    byte[] bytes = null;
    if (m.Content != null) { foreach (var h in m.Content.Headers) headers[h.Key] = string.Join(",", h.Value); bytes = await m.Content.ReadAsByteArrayAsync(); }
    return new JObject { ["type"] = "result", ["status"] = (int)m.StatusCode, ["headers"] = headers, ["body"] = bytes == null ? null : Convert.ToBase64String(bytes) };
  }
}
internal sealed class LocalContext : IScriptContext {
  public string CorrelationId { get; set; }
  public string OperationId { get; set; }
  public HttpRequestMessage Request { get; set; }
  public ILogger Logger { get; } = Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance;
  static readonly SemaphoreSlim Channel = new SemaphoreSlim(1, 1);
  public async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) {
    var described = await Wire.Describe(request);
    described["type"] = "send";
    await Channel.WaitAsync(cancellationToken);
    JObject answer;
    try { Wire.Write(described); answer = Wire.Read(); } finally { Channel.Release(); }
    if (answer["error"] != null) throw new HttpRequestException((string)answer["error"]);
    var response = new HttpResponseMessage((HttpStatusCode)(int)answer["status"]) { RequestMessage = request };
    var body = (string)answer["body"];
    response.Content = new ByteArrayContent(body == null ? new byte[0] : Convert.FromBase64String(body));
    foreach (var h in (JObject)answer["headers"] ?? new JObject()) {
      var value = (string)h.Value;
      if (!response.Headers.TryAddWithoutValidation(h.Key, value)) response.Content.Headers.TryAddWithoutValidation(h.Key, value);
    }
    return response;
  }
}
public static class Program {
  public static async Task<int> Main() {
    try {
      var input = Wire.Read();
      var context = new LocalContext { CorrelationId = (string)input["correlationId"], OperationId = (string)input["operationId"], Request = Wire.Request((JObject)input["request"]) };
      using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds((double?)input["timeoutMs"] ?? 120000));
      var script = new Script { Context = context, CancellationToken = cancel.Token };
      var response = await script.ExecuteAsync();
      Wire.Write(await Wire.Describe(response));
      return 0;
    } catch (Exception error) {
      Wire.Write(new JObject { ["type"] = "error", ["message"] = error.GetType().Name + ": " + error.Message });
      return 1;
    }
  }
}
`;
const project = sdk => `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net${sdk.split('.')[0]}.0</TargetFramework>
    <Nullable>disable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <AssemblyName>ConnectorScriptHost</AssemblyName>
    <NoWarn>CS1998;CS8632;CS0168</NoWarn>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
    <PackageReference Include="Microsoft.Extensions.Logging.Abstractions" Version="8.0.0" />
  </ItemGroup>
</Project>
`;

const builds = new Map();
let temporaryRoot;
// ponytail: one host process per call (about 100 ms start); a resident host per script is the upgrade if calls get frequent.
/**
 * createScriptHost({ stateDirectory, command }): { available(), prepare(script), run({ script, operationId, correlationId,
 * request, timeoutMs, signal, send }) } where request is { method, url, headers, body (string | Uint8Array | undefined) } and
 * send(request) answers { statusCode, headers, body } for a Context.SendAsync request (its body a Buffer or undefined).
 * run answers { statusCode, headers, body } with a parsed JSON body when the response is JSON.
 */
export function createScriptHost({ stateDirectory = null, command = 'dotnet', trusted = [] } = {}) {
  // Memory-only runtimes never share a predictable, pre-creatable OS temp path.
  // Allocate only after trust and SDK checks, as for state-backed runtimes.
  let root = stateDirectory ? path.join(stateDirectory, 'connector-scripts') : null;
  const available = () => dotnetSdk(command) !== null;
  /** Whether connectorScripts registers this connector's script text. */
  const trusts = (connector, script) => Boolean(script) && trusted.some(entry => entry.connector === connector && entry.sha256 === scriptHash(script.text));
  function prepare(script, connector) {
    if (!trusts(connector, script)) return Promise.reject(untrusted(connector, script));
    const sdk = dotnetSdk(command);
    if (!sdk) return Promise.reject(missing(command));
    try { root ??= temporaryRoot ??= fs.mkdtempSync(path.join(os.tmpdir(), 'mirage-connector-scripts-')); }
    catch (error) { return Promise.reject(error); }
    const hash = createHash('sha256').update(sdk + '\n' + script.text).digest('hex').slice(0, 32), dir = path.join(root, hash), dll = path.join(dir, 'out', 'ConnectorScriptHost.dll');
    if (builds.has(dll)) return builds.get(dll);
    const built = (async () => {
      if (fs.existsSync(dll)) return dll;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const [name, content] of Object.entries({
        'ConnectorScriptHost.csproj': project(sdk),
        'GlobalUsings.cs': USINGS.map(n => `global using ${n};`).join('\n') + '\n',
        'Host.cs': HOST,
        'Script.cs': script.text,
      })) {
        const file = path.join(dir, name);
        try { fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 }); }
        catch (error) {
          // A failed build may leave the exact sources for a retry. Never
          // truncate a pre-existing file or follow a link outside this cache.
          if (error.code !== 'EEXIST' || readLocalFileSync(file, { root: dir, encoding: 'utf8' }) !== content) throw error;
        }
      }
      const output = await execute(command, ['build', '-c', 'Release', '-o', 'out', '--nologo', '-v', 'q'], dir, 5 * 60000);
      if (output.code !== 0 || !fs.existsSync(dll)) {
        const errors = [...new Set(output.text.split(/\r?\n/).filter(line => /error/i.test(line)).map(line => line.split(dir).join('').replace(/\s*\[[^\]]*\.csproj\]$/, '').replace(/^[\\/]*Script\.cs/, 'script.csx').trim()))].slice(0, 5);
        throw new DataError('The custom connector script did not build: ' + (errors.join(' | ') || 'dotnet build failed.'), 502, 'ProviderFailed');
      }
      return dll;
    })();
    builds.set(dll, built);
    built.catch(() => builds.delete(dll));
    return built;
  }
  async function run({ connector, script, operationId, correlationId = null, request, timeoutMs = 120000, signal = null, send }) {
    if (!trusts(connector, script)) throw untrusted(connector, script);
    if (!available()) throw missing(command);
    const dll = await prepare(script, connector);
    const limit = Math.max(1, Math.min(timeoutMs, 120000));
    const body = request.body === undefined || request.body === null ? null : Buffer.from(request.body).toString('base64');
    const child = spawn(command, [dll], { cwd: path.dirname(path.dirname(dll)), env: hostEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stop = () => child.kill();
    const timer = setTimeout(stop, limit + 5000);
    signal?.addEventListener('abort', stop, { once: true });
    const write = value => child.stdin.write(JSON.stringify(value) + '\n');
    let buffer = '', result = null, failure = null, chain = Promise.resolve();
    const decode = answer => ({ statusCode: answer.status, headers: answer.headers ?? {}, body: answer.body == null ? null : Buffer.from(answer.body, 'base64') });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
        if (!line) continue;
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.type === 'result') result = decode(message);
        else if (message.type === 'error') failure = message.message;
        else if (message.type === 'send') chain = chain.then(async () => {
          try {
            const answer = await send({ method: message.method, url: message.url, headers: message.headers ?? {}, body: message.body == null ? undefined : Buffer.from(message.body, 'base64') });
            const bytes = answer.body == null ? null : Buffer.isBuffer(answer.body) ? answer.body : Buffer.from(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
            write({ status: answer.statusCode, headers: answer.headers ?? {}, body: bytes ? bytes.toString('base64') : null });
          } catch (error) { write({ error: error.message }); }
        });
      }
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    const exited = new Promise(resolve => { child.on('close', resolve); child.on('error', () => resolve(-1)); });
    write({ operationId, correlationId, timeoutMs: limit, request: { method: request.method, url: request.url, headers: request.headers ?? {}, body } });
    await exited;
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    if (signal?.aborted) throw signal.reason instanceof DataError ? signal.reason : new DataError('The connector call was cancelled.', 409, 'FlowRunCancelled');
    if (!result) throw new DataError('The custom connector script failed: ' + (failure ?? (stderr.trim().split(/\r?\n/).at(-1) || 'the host ended without a response.')), 502, 'ProviderFailed');
    const type = Object.entries(result.headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
    const text = result.body?.toString('utf8') ?? '';
    let parsed = text || null;
    if (/json/i.test(type) && text) { try { parsed = JSON.parse(text); } catch { throw new DataError('The custom connector script answered invalid JSON.', 502, 'ProviderFailed'); } }
    return { statusCode: result.statusCode, headers: result.headers, body: parsed };
  }
  return { available, trusts, prepare, run, command, missing: () => missing(command).message, untrusted: (connector, script) => untrusted(connector, script).message };
}

function execute(command, args, cwd, timeout) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, windowsHide: true, env: hostEnvironment(process.env, { build: true }) });
    let text = '';
    child.stdout.on('data', c => { text = (text + c).slice(-20000); });
    child.stderr.on('data', c => { text = (text + c).slice(-20000); });
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('close', code => { clearTimeout(timer); resolve({ code, text }); });
    child.on('error', error => { clearTimeout(timer); resolve({ code: -1, text: error.message }); });
  });
}
