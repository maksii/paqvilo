import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export function environmentOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Environment must be an HTTPS organisation origin, without credentials, query or path.');
  return url.origin;
}

export function pacExecutable() {
  if (process.env.PAQVILO_PAC_EXECUTABLE) return process.env.PAQVILO_PAC_EXECUTABLE;
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const name of process.platform === 'win32' ? ['pac.exe', 'pac.launcher.exe'] : ['pac']) {
      const file = path.join(directory.replace(/^"|"$/g, ''), name);
      if (existsSync(file)) return file;
    }
  }
  throw new Error('PAC executable missing. Install PAC or set PAQVILO_PAC_EXECUTABLE to its native executable (not a shell wrapper).');
}

// Never inherit output: PAC registration and auth commands can emit secrets.
export function runProcess(executable, args, { input = '', timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    child.on('error', () => { clearTimeout(timer); reject(new Error('External command could not start. Check the executable and permissions.')); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

export async function protectSecret(value, decrypt = false) {
  if (process.platform !== 'win32') throw new Error('Stored credentials require Windows DPAPI. On other hosts use environment-provided credentials.');
  const action = decrypt ? 'Unprotect' : 'Protect';
  const script = `Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=${decrypt ? '[Convert]::FromBase64String($v)' : '[Text.Encoding]::UTF8.GetBytes($v)'}; $r=[Security.Cryptography.ProtectedData]::${action}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write(${decrypt ? '[Text.Encoding]::UTF8.GetString($r)' : '[Convert]::ToBase64String($r)'});`;
  const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: value, timeout: 15_000 });
  if (result.code !== 0 || result.timedOut) throw new Error('Windows credential encryption/decryption failed; no plaintext fallback.');
  return result.stdout;
}

export function parseRegistrationOutput(output) {
  if (/^\s*Error:/im.test(output)) throw new Error('PAC reported an error, even if its process exit code was zero.');
  const start = output.search(/Tenant\s*ID\s+Application\s*ID\s+Client\s*Secret/i);
  if (start < 0) throw new Error('PAC credential table was not recognized.');
  const row = output.slice(start).match(new RegExp(`^\\s*(${GUID})\\s+(${GUID})\\s+(\\S+)\\s+(.+?)\\s*$`, 'im'));
  if (!row) throw new Error('PAC credential row was not recognized.');
  return { tenantId: row[1].toLowerCase(), clientId: row[2].toLowerCase(), clientSecret: row[3], expiration: row[4].trim() };
}

export async function privateJson(file, value, exclusive = false) {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  if (exclusive) return fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try {
    // Windows readers/antivirus can briefly lock the destination. Only retry the
    // local atomic replacement; never repeat a Dataverse mutation for this error.
    for(let attempt=0;;attempt++){
      try{await fs.rename(temp,file);break;}catch(error){if(!['EPERM','EBUSY','EACCES'].includes(error.code)||attempt>=9)throw error;await delay(Math.min(500,25*2**attempt));}
    }
  } catch(error) { await fs.unlink(temp).catch(()=>{}); throw error; }
}

export async function activeEnvironment() {
  const result = await runProcess(pacExecutable(), ['env', 'who']);
  if (result.code !== 0 || result.timedOut) throw new Error('PAC cannot identify the active environment. Sign in with pac auth create first.');
  const field = label => result.stdout.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, 'm'))?.[1].trim();
  return { environmentUrl: environmentOrigin(field('Org URL')), environmentId: field('Environment ID'), organisationId: field('Org ID'), organisationName: field('Unique Name'), friendlyName: field('Friendly Name') };
}

export function publicConnection(connection) {
  const { schemaVersion, environmentUrl, environmentId, organisationId, organisationName, friendlyName, tenantId, clientId, applicationName, role, expiration, createdAt, credentialSource } = connection;
  return { schemaVersion, environmentUrl, environmentId, organisationId, organisationName, friendlyName, tenantId, clientId:clientId??connection.partialApplicationId, applicationName, role, expiration, createdAt, credentialSource, state:connection.state, secretStored: Boolean(connection.protectedSecret), protection: connection.protectedSecret ? 'Windows DPAPI CurrentUser' : credentialSource==='environment'?'environment':null };
}

function privateStatePath(file) {
  if (!path.resolve(file).split(path.sep).includes('.paqvilo')) throw new Error('Connection and registration state must be under an ignored .paqvilo directory.');
}

export async function registerApplication({ connectionFile, environment, applicationName, role = 'System Customizer' }) {
  if (!connectionFile || !applicationName) throw new Error('Registration requires --connection and --name.');
  privateStatePath(connectionFile);
  if (existsSync(connectionFile)) throw new Error('Connection already exists; registration will not create a duplicate app. Inspect or use another connection path.');
  const active = await activeEnvironment();
  const environmentUrl = environment ? environmentOrigin(environment) : active.environmentUrl;
  if (environmentUrl !== active.environmentUrl) throw new Error('Select the intended environment in PAC first; registration must match its active environment.');
  await protectSecret('encryption-preflight');
  const pending = `${connectionFile}.registration.json`;
  await privateJson(pending, { schemaVersion: 1, environmentUrl, applicationName, role, startedAt: new Date().toISOString(), state: 'Starting' }, true);
  const result = await runProcess(pacExecutable(), ['admin', 'create-service-principal', '--environment', environmentUrl, '--name', applicationName, '--role', role]);
  // Save encrypted recovery evidence before parsing or reporting anything.
  const reportedError=/^\s*Error:/im.test(result.stdout+'\n'+result.stderr);
  const partialApplicationId=result.stdout.match(new RegExp(`Application\\s+['\"]?(${GUID})`, 'i'))?.[1];
  await privateJson(pending, { schemaVersion: 1, ...active, applicationName, role, partialApplicationId, state: result.code === 0 && !result.timedOut && !reportedError ? 'Returned' : 'FailedOrUnknown', code: result.code, timedOut: result.timedOut, protectedOutput: await protectSecret(JSON.stringify({ stdout: result.stdout, stderr: result.stderr })) });
  if (result.code !== 0 || result.timedOut || reportedError) throw new Error('PAC registration failed or its commit is partial/unknown. Encrypted recovery details saved; do not blindly register another app.');
  let credentials;
  try { credentials = parseRegistrationOutput(result.stdout); }
  catch { throw new Error('PAC returned an unrecognized credential format. Encrypted recovery details saved; inspect locally without printing secrets.'); }
  const connection = { schemaVersion: 1, ...active, tenantId: credentials.tenantId, clientId: credentials.clientId, applicationName, role, expiration: credentials.expiration, createdAt: new Date().toISOString(), credentialSource: 'dpapi', protectedSecret: await protectSecret(credentials.clientSecret) };
  await privateJson(connectionFile, connection, true);
  return publicConnection(connection);
}

export async function connectExistingApplication({ registrationFile, secretFile, connectionFile, role, consumeSecretFile=false }) {
  if(!registrationFile||!secretFile||!connectionFile) throw new Error('Connect requires registration, secret-file and connection paths.');
  privateStatePath(registrationFile);privateStatePath(secretFile);privateStatePath(connectionFile);
  if(existsSync(connectionFile)) throw new Error('Connection already exists; existing credentials will not be overwritten.');
  const registration=JSON.parse(await fs.readFile(registrationFile,'utf8'));
  const supplied=parseCredentialFile(await fs.readFile(secretFile,'utf8'));
  const secret=supplied.value;
  if(!secret||secret.length>4096||/\s/.test(secret)) throw new Error('Secret file must contain only the client-secret value.');
  if(supplied.clientId&&registration.partialApplicationId&&supplied.clientId.toLowerCase()!==registration.partialApplicationId.toLowerCase()) throw new Error('Credential application ID differs from the saved registration; reconcile the identity before connecting.');
  const connection={schemaVersion:1,environmentUrl:environmentOrigin(registration.environmentUrl),environmentId:registration.environmentId,organisationId:registration.organisationId,organisationName:registration.organisationName,friendlyName:registration.friendlyName,tenantId:supplied.tenantId??registration.tenantId,clientId:supplied.clientId??registration.partialApplicationId??registration.clientId,secretId:supplied.secretId??null,applicationName:registration.applicationName,role:role??registration.role,expiration:supplied.expiration??null,createdAt:new Date().toISOString(),credentialSource:'dpapi',protectedSecret:await protectSecret(secret),state:'Connected'};
  for(const field of ['tenantId','clientId']) if(!new RegExp(`^${GUID}$`,'i').test(connection[field]??'')) throw new Error('Registration is missing its tenant/application identity.');
  const {connectedClient}=await import('./client.mjs');
  const client=connectedClient(connection);
  const verified=await client.verify(connection.organisationId);
  const roles=await client.list(`systemusers(${verified.applicationUserId})/systemuserroles_association?$select=name,roleid`);
  connection.applicationUserId=verified.applicationUserId;
  connection.verifiedRoles=roles.map(r=>({name:r.name,id:r.roleid}));
  await privateJson(connectionFile,connection,true);
  await privateJson(registrationFile,{...registration,state:'Connected',connectionFile:path.resolve(connectionFile),role:connection.role,applicationUserId:verified.applicationUserId});
  if(consumeSecretFile) await fs.unlink(secretFile);
  return {...publicConnection(connection),applicationUserId:verified.applicationUserId,verifiedRoles:connection.verifiedRoles,sourceSecretFileRemoved:consumeSecretFile};
}

export function parseCredentialFile(input) {
  const text=input.replace(/^\uFEFF/,'').trim();
  let fields;
  try { const parsed=JSON.parse(text);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)) fields=parsed; } catch {}
  const normalize=key=>key.toLowerCase().replace(/[ _-]/g,'');
  if(!fields) {
    const lines=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    const named=lines.map(line=>line.match(/^([a-zA-Z _-]+)\s*[:=]\s*(.*)$/)).filter(Boolean);
    if(named.length===lines.length) fields=Object.fromEntries(named.map(m=>[m[1],m[2].replace(/^["']|["']$/g,'')]));
    else if(lines.length===2&&normalize(lines[0].split(',')[0])==='clientid') fields=Object.fromEntries(lines[0].split(',').map((key,i)=>[key,lines[1].split(',')[i]?.trim().replace(/^["']|["']$/g,'')]));
    else if(lines.length===4&&new RegExp(`^${GUID}$`,'i').test(lines[0])&&new RegExp(`^${GUID}$`,'i').test(lines[1])) fields={clientId:lines[0],tenantId:lines[1],value:lines[2],secretId:lines[3]};
    else return {value:text};
  }
  const values=Object.fromEntries(Object.entries(fields).map(([key,value])=>[normalize(key),value]));
  const result={value:values.value??values.clientsecret,clientId:values.clientid??values.applicationid,tenantId:values.tenantid,secretId:values.secretid,expiration:values.expiration??values.expiresat};
  if(typeof result.value!=='string') throw new Error('Credential file requires a value/clientSecret field.');
  for(const key of ['clientId','tenantId','secretId']) if(result[key]&&!new RegExp(`^${GUID}$`,'i').test(result[key])) throw new Error('Credential file contains an invalid identity field.');
  return result;
}

export async function loadConnection(file) {
  const connection = JSON.parse(await fs.readFile(file, 'utf8'));
  if (connection.schemaVersion !== 1) throw new Error('Unsupported connection schema.');
  connection.environmentUrl = environmentOrigin(connection.environmentUrl);
  for (const field of ['tenantId', 'clientId']) if (!new RegExp(`^${GUID}$`, 'i').test(connection[field] ?? '')) throw new Error(`Connection ${field} must be a GUID.`);
  return connection;
}

export function tokenProvider(connection, { fetchImpl = fetch } = {}) {
  // Validate at the API boundary too: connectedClient also accepts caller-owned
  // objects, rather than only records read through loadConnection.
  for (const field of ['tenantId','clientId']) if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connection[field] ?? '')) throw new Error(`Connection ${field} must be a GUID.`);
  const origin = environmentOrigin(connection.environmentUrl);
  const endpoint = new URL('https://login.microsoftonline.com/');
  endpoint.pathname = `/${connection.tenantId}/oauth2/v2.0/token`;
  let cached;
  return async () => {
    if (cached && Date.now() < cached.until) return cached.token;
    const secret = connection.credentialSource === 'environment' ? process.env[connection.secretEnvironmentVariable] : await protectSecret(connection.protectedSecret, true);
    if (!secret) throw new Error('Connection credential is unavailable.');
    let response;
    try { response = await fetchImpl(endpoint.href, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      body: new URLSearchParams({ client_id: connection.clientId, client_secret: secret, grant_type: 'client_credentials', scope: `${origin}/.default` }),
    }); } catch { throw new Error('Application token request failed (network/timeout); credential details withheld.'); }
    if (!response.ok) throw new Error(`Application token request failed (HTTP ${response.status}); credential response withheld.`);
    let body;
    try { body = await response.json(); } catch { throw new Error('Invalid token response; credential details withheld.'); }
    if (typeof body.access_token !== 'string' || !Number.isFinite(Number(body.expires_in))) throw new Error('Invalid token response.');
    cached = { token: body.access_token, until: Date.now() + Math.max(0, Number(body.expires_in) - 120) * 1000 };
    return cached.token;
  };
}
