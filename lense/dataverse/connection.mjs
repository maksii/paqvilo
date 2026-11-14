import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isLoopbackOrigin } from './client.mjs';
import { matchNamedLine } from '../../mirage/lib/text-scanning.mjs';

const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export function environmentOrigin(value, { allowLoopback = false } = {}) {
  const url = new URL(value);
  const secure = url.protocol === 'https:' || (allowLoopback && url.protocol === 'http:' && isLoopbackOrigin(url));
  if (!secure || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname))
    throw new Error('Environment must be an HTTPS organisation origin, without credentials, query or path.');
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
  throw new Error(
    'PAC executable missing. Install PAC or set PAQVILO_PAC_EXECUTABLE to its native executable (not a shell wrapper).',
  );
}

// Never inherit output: PAC registration and auth commands can emit secrets.
export function runProcess(executable, args, { input = '', timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stdout = '',
      stderr = '',
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.stdout.setEncoding('utf8').on('data', (text) => {
      stdout += text;
    });
    child.stderr.setEncoding('utf8').on('data', (text) => {
      stderr += text;
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('External command could not start. Check the executable and permissions.'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export async function protectSecret(value, decrypt = false) {
  if (process.platform !== 'win32')
    throw new Error('Stored credentials require Windows DPAPI. On other hosts use environment-provided credentials.');
  const action = decrypt ? 'Unprotect' : 'Protect';
  const script = `$ErrorActionPreference='Stop'; try { [Console]::InputEncoding=New-Object Text.UTF8Encoding($false); [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=${decrypt ? '[Convert]::FromBase64String($v)' : '[Text.Encoding]::UTF8.GetBytes($v)'}; $r=[Security.Cryptography.ProtectedData]::${action}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write(${decrypt ? '[Text.Encoding]::UTF8.GetString($r)' : '[Convert]::ToBase64String($r)'}); } catch { exit 1; }`;
  // A cold Windows PowerShell startup can exceed 15 seconds on a busy host.
  // Keep the operation bounded, including startup, without retrying or persisting input.
  const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: value,
    timeout: 60_000,
  });
  if (
    result.code !== 0 ||
    result.timedOut ||
    result.stderr ||
    (!decrypt && !/^[A-Za-z0-9+/]+={0,2}$/.test(result.stdout))
  )
    throw new Error('Windows credential encryption/decryption failed; no plaintext fallback.');
  return result.stdout;
}

export function parseRegistrationOutput(output) {
  if (/^(?:(?![\r\n\u2028\u2029])\s)*Error:/im.test(output))
    throw new Error('PAC reported an error, even if its process exit code was zero.');
  const start = output.search(/Tenant\s*ID\s+Application\s*ID\s+Client\s*Secret/i);
  if (start < 0) throw new Error('PAC credential table was not recognized.');
  const row = output.slice(start).match(new RegExp(String.raw`^\s*(${GUID})\s+(${GUID})\s+(\S+)\s+(.+?)\s*$`, 'im'));
  if (!row) throw new Error('PAC credential row was not recognized.');
  return {
    tenantId: row[1].toLowerCase(),
    clientId: row[2].toLowerCase(),
    clientSecret: row[3],
    expiration: row[4].trim(),
  };
}

export async function privateJson(file, value, exclusive = false) {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  if (exclusive) return fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try {
    // Windows readers/antivirus can briefly lock the destination. Only retry the
    // local atomic replacement; never repeat a Dataverse mutation for this error.
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(temp, file);
        break;
      } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 9) throw error;
        await delay(Math.min(500, 25 * 2 ** attempt));
      }
    }
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

export async function activeEnvironment() {
  const result = await runProcess(pacExecutable(), ['env', 'who']);
  if (result.code !== 0 || result.timedOut)
    throw new Error('PAC cannot identify the active environment. Sign in with pac auth create first.');
  const field = (label) => result.stdout.match(new RegExp(String.raw`^\s*${label}:\s*(.+)$`, 'm'))?.[1].trim();
  return {
    environmentUrl: environmentOrigin(field('Org URL')),
    environmentId: field('Environment ID'),
    organisationId: field('Org ID'),
    organisationName: field('Unique Name'),
    friendlyName: field('Friendly Name'),
  };
}

export function publicConnection(connection) {
  const {
    schemaVersion,
    environmentUrl,
    environmentId,
    organisationId,
    organisationName,
    friendlyName,
    tenantId,
    clientId,
    applicationName,
    role,
    expiration,
    createdAt,
    credentialSource,
  } = connection;
  const protection = () => {
    if (connection.protectedSecret) return 'Windows DPAPI CurrentUser';
    if (credentialSource === 'environment') return 'environment';
    return null;
  };
  return {
    schemaVersion,
    environmentUrl,
    environmentId,
    organisationId,
    organisationName,
    friendlyName,
    tenantId,
    clientId: clientId ?? connection.partialApplicationId,
    applicationName,
    role,
    expiration,
    createdAt,
    credentialSource,
    state: connection.state,
    secretStored: Boolean(connection.protectedSecret),
    protection: protection(),
  };
}

function privateStatePath(file) {
  if (!path.resolve(file).split(path.sep).includes('.paqvilo'))
    throw new Error('Connection and registration state must be under an ignored .paqvilo directory.');
}

function originOf(value) {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

// Every *.json file directly in the folder is read. Only the environment and application name are kept; a file
// without an environment, or one that is malformed or unreadable, is not a registration and cannot block a new one.
async function registrationRecords(directory) {
  let names;
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    const file = path.join(directory, name);
    try {
      const record = JSON.parse(await fs.readFile(file, 'utf8'));
      if (typeof record?.environmentUrl === 'string')
        records.push({ file, environmentUrl: record.environmentUrl, applicationName: record.applicationName });
    } catch {
      /* A record that cannot be read is not a registration, so it cannot block a new one. */
    }
  }
  return records;
}

function registrationExists(message) {
  return Object.assign(new Error(message), { code: 'REGISTRATION_EXISTS' });
}

async function refuseExistingRegistration({ connectionFile, environmentUrl, applicationName, allowAdditional }) {
  if (allowAdditional) return;
  const origin = environmentUrl ? originOf(environmentUrl) : null;
  const existing = (await registrationRecords(path.dirname(path.resolve(connectionFile)))).find(
    (record) =>
      (origin !== null && originOf(record.environmentUrl) === origin) || record.applicationName === applicationName,
  );
  if (!existing) return;
  throw registrationExists(
    `An application is already registered for this environment or name in ${existing.file}. ` +
      `Reuse it with 'paqvilo dataverse inspect' or 'verify' using --connection ${existing.file}. ` +
      'Pass --allow-additional-application to create another.',
  );
}

function applicationsUnchecked() {
  return new Error(
    'Existing applications could not be checked with PAC, so no application was created. ' +
      'Pass --allow-additional-application to register without this check.',
  );
}

// PAC CLI 2.13.1 `pac admin list-service-principal` offers only --filter and --max and no machine-readable output,
// so the listing is parsed from its table.
// Output is split into cells on tabs and runs of two or more spaces, so a longer name that only starts with the
// requested one is a different application. Output is parsed here and never copied into a message.
async function listedApplicationNames(applicationName) {
  let result;
  try {
    result = await runProcess(pacExecutable(), [
      'admin',
      'list-service-principal',
      '--filter',
      applicationName,
      '--max',
      '50',
    ]);
  } catch {
    throw applicationsUnchecked();
  }
  if (result.code !== 0 || result.timedOut) throw applicationsUnchecked();
  return result.stdout
    .split(/\r?\n/)
    .flatMap((line) => line.split(/\t| {2,}/))
    .map((cell) => cell.trim().toLowerCase());
}

// The tenant listing is the registry: an application it already lists under the requested name is not created again.
async function refuseListedApplication({ applicationName, allowAdditional }) {
  if (allowAdditional) return;
  const wanted = applicationName.trim().toLowerCase();
  if ((await listedApplicationNames(applicationName)).includes(wanted))
    throw registrationExists(
      `An application named ${applicationName.trim()} is already registered in this tenant, ` +
        'and the check matches by application name. ' +
        'Reuse its existing connection file with paqvilo dataverse inspect or verify --connection FILE, ' +
        'or pass --allow-additional-application to create another.',
    );
}

export async function registerApplication({
  connectionFile,
  environment,
  applicationName,
  role = 'System Customizer',
  allowAdditionalApplication = false,
  protect = protectSecret,
}) {
  if (!connectionFile || !applicationName) throw new Error('Registration requires --connection and --name.');
  privateStatePath(connectionFile);
  if (existsSync(connectionFile))
    throw new Error(
      'Connection already exists; registration will not create a duplicate app. Inspect or use another connection path.',
    );
  const requested = environment ? environmentOrigin(environment) : null;
  await refuseExistingRegistration({
    connectionFile,
    environmentUrl: requested,
    applicationName,
    allowAdditional: allowAdditionalApplication,
  });
  const active = await activeEnvironment();
  const environmentUrl = requested ?? active.environmentUrl;
  if (environmentUrl !== active.environmentUrl)
    throw new Error('Select the intended environment in PAC first; registration must match its active environment.');
  await refuseExistingRegistration({
    connectionFile,
    environmentUrl,
    applicationName,
    allowAdditional: allowAdditionalApplication,
  });
  await refuseListedApplication({ applicationName, allowAdditional: allowAdditionalApplication });
  await protect('encryption-preflight');
  const pending = `${connectionFile}.registration.json`;
  await privateJson(
    pending,
    { schemaVersion: 1, environmentUrl, applicationName, role, startedAt: new Date().toISOString(), state: 'Starting' },
    true,
  );
  const result = await runProcess(pacExecutable(), [
    'admin',
    'create-service-principal',
    '--environment',
    environmentUrl,
    '--name',
    applicationName,
    '--role',
    role,
  ]);
  // Save encrypted recovery evidence before parsing or reporting anything.
  const reportedError = /^(?:(?![\r\n\u2028\u2029])\s)*Error:/im.test(result.stdout + '\n' + result.stderr);
  const partialApplicationId = result.stdout.match(new RegExp(String.raw`Application\s+['"]?(${GUID})`, 'i'))?.[1];
  await privateJson(pending, {
    schemaVersion: 1,
    ...active,
    applicationName,
    role,
    partialApplicationId,
    state: result.code === 0 && !result.timedOut && !reportedError ? 'Returned' : 'FailedOrUnknown',
    code: result.code,
    timedOut: result.timedOut,
    protectedOutput: await protect(JSON.stringify({ stdout: result.stdout, stderr: result.stderr })),
  });
  if (result.code !== 0 || result.timedOut || reportedError)
    throw new Error(
      'PAC registration failed or its commit is partial/unknown. Encrypted recovery details saved; do not blindly register another app.',
    );
  let credentials;
  try {
    credentials = parseRegistrationOutput(result.stdout);
  } catch {
    throw new Error(
      'PAC returned an unrecognized credential format. Encrypted recovery details saved; inspect locally without printing secrets.',
    );
  }
  const connection = {
    schemaVersion: 1,
    ...active,
    tenantId: credentials.tenantId,
    clientId: credentials.clientId,
    applicationName,
    role,
    expiration: credentials.expiration,
    createdAt: new Date().toISOString(),
    credentialSource: 'dpapi',
    protectedSecret: await protect(credentials.clientSecret),
  };
  await privateJson(connectionFile, connection, true);
  return publicConnection(connection);
}

export async function connectExistingApplication({
  registrationFile,
  secretFile,
  connectionFile,
  role,
  consumeSecretFile = false,
}) {
  if (!registrationFile || !secretFile || !connectionFile)
    throw new Error('Connect requires registration, secret-file and connection paths.');
  privateStatePath(registrationFile);
  privateStatePath(secretFile);
  privateStatePath(connectionFile);
  if (existsSync(connectionFile))
    throw new Error('Connection already exists; existing credentials will not be overwritten.');
  const registration = JSON.parse(await fs.readFile(registrationFile, 'utf8'));
  const supplied = parseCredentialFile(await fs.readFile(secretFile, 'utf8'));
  const secret = supplied.value;
  if (!secret || secret.length > 4096 || /\s/.test(secret))
    throw new Error('Secret file must contain only the client-secret value.');
  if (
    supplied.clientId &&
    registration.partialApplicationId &&
    supplied.clientId.toLowerCase() !== registration.partialApplicationId.toLowerCase()
  )
    throw new Error(
      'Credential application ID differs from the saved registration; reconcile the identity before connecting.',
    );
  const connection = {
    schemaVersion: 1,
    environmentUrl: environmentOrigin(registration.environmentUrl),
    environmentId: registration.environmentId,
    organisationId: registration.organisationId,
    organisationName: registration.organisationName,
    friendlyName: registration.friendlyName,
    tenantId: supplied.tenantId ?? registration.tenantId,
    clientId: supplied.clientId ?? registration.partialApplicationId ?? registration.clientId,
    secretId: supplied.secretId ?? null,
    applicationName: registration.applicationName,
    role: role ?? registration.role,
    expiration: supplied.expiration ?? null,
    createdAt: new Date().toISOString(),
    credentialSource: 'dpapi',
    protectedSecret: await protectSecret(secret),
    state: 'Connected',
  };
  for (const field of ['tenantId', 'clientId'])
    if (!new RegExp(`^${GUID}$`, 'i').test(connection[field] ?? ''))
      throw new Error('Registration is missing its tenant/application identity.');
  const { connectedClient } = await import('./client.mjs');
  const client = connectedClient(connection);
  const verified = await client.verify(connection.organisationId);
  const roles = await client.list(
    `systemusers(${verified.applicationUserId})/systemuserroles_association?$select=name,roleid`,
  );
  connection.applicationUserId = verified.applicationUserId;
  connection.verifiedRoles = roles.map((r) => ({ name: r.name, id: r.roleid }));
  await privateJson(connectionFile, connection, true);
  await privateJson(registrationFile, {
    ...registration,
    state: 'Connected',
    connectionFile: path.resolve(connectionFile),
    role: connection.role,
    applicationUserId: verified.applicationUserId,
  });
  if (consumeSecretFile) await fs.unlink(secretFile);
  return {
    ...publicConnection(connection),
    applicationUserId: verified.applicationUserId,
    verifiedRoles: connection.verifiedRoles,
    sourceSecretFileRemoved: consumeSecretFile,
  };
}

export function parseCredentialFile(input) {
  const text = input.replace(/^\uFEFF/, '').trim();
  let fields;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fields = parsed;
  } catch {
    /* Optional inspection or cleanup failure must not interrupt the owning operation. */
  }
  const normalize = (key) => key.toLowerCase().replace(/[ _-]/g, '');
  if (!fields) {
    fields = credentialFieldsFromLines(text, normalize);
    if (!fields) return { value: text };
  }
  const values = Object.fromEntries(Object.entries(fields).map(([key, value]) => [normalize(key), value]));
  const result = {
    value: values.value ?? values.clientsecret,
    clientId: values.clientid ?? values.applicationid,
    tenantId: values.tenantid,
    secretId: values.secretid,
    expiration: values.expiration ?? values.expiresat,
  };
  if (typeof result.value !== 'string') throw new Error('Credential file requires a value/clientSecret field.');
  for (const key of ['clientId', 'tenantId', 'secretId'])
    if (result[key] && !new RegExp(`^${GUID}$`, 'i').test(result[key]))
      throw new Error('Credential file contains an invalid identity field.');
  return result;
}

function credentialFieldsFromLines(text, normalize) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const named = lines.map(matchNamedLine).filter(Boolean);
  if (named.length === lines.length)
    return Object.fromEntries(named.map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
  if (lines.length === 2 && normalize(lines[0].split(',')[0]) === 'clientid')
    return Object.fromEntries(
      lines[0].split(',').map((key, i) => [
        key,
        lines[1]
          .split(',')
          [i]?.trim()
          .replace(/^["']|["']$/g, ''),
      ]),
    );
  if (lines.length === 4 && new RegExp(`^${GUID}$`, 'i').test(lines[0]) && new RegExp(`^${GUID}$`, 'i').test(lines[1]))
    return { clientId: lines[0], tenantId: lines[1], value: lines[2], secretId: lines[3] };
  return null;
}

export async function loadConnection(file, { allowLoopback = false } = {}) {
  const connection = JSON.parse(await fs.readFile(file, 'utf8'));
  if (connection.schemaVersion !== 1) throw new Error('Unsupported connection schema.');
  connection.environmentUrl = environmentOrigin(connection.environmentUrl, { allowLoopback });
  for (const field of ['tenantId', 'clientId'])
    if (!new RegExp(`^${GUID}$`, 'i').test(connection[field] ?? ''))
      throw new Error(`Connection ${field} must be a GUID.`);
  return connection;
}

// Production authority unless a loopback test authority is explicitly allowed.
function authorityEndpoint(connection, allowLoopback) {
  if (!allowLoopback || connection.authorityHost == null) return new URL('https://login.microsoftonline.com/');
  let authority;
  try {
    authority = new URL(connection.authorityHost);
  } catch {
    authority = null;
  }
  if (
    !authority ||
    !isLoopbackOrigin(authority) ||
    authority.username ||
    authority.password ||
    authority.search ||
    authority.hash ||
    !['', '/'].includes(authority.pathname)
  )
    throw new Error('authorityHost must be a loopback origin');
  return new URL(`${authority.origin}/`);
}

export function tokenProvider(connection, { fetchImpl = fetch, allowLoopback = false } = {}) {
  // Validate at the API boundary too: connectedClient also accepts caller-owned
  // objects, rather than only records read through loadConnection.
  for (const field of ['tenantId', 'clientId'])
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connection[field] ?? ''))
      throw new Error(`Connection ${field} must be a GUID.`);
  const origin = environmentOrigin(connection.environmentUrl, { allowLoopback });
  const endpoint = authorityEndpoint(connection, allowLoopback);
  endpoint.pathname = `/${connection.tenantId}/oauth2/v2.0/token`;
  let cached;
  return async () => {
    if (cached && Date.now() < cached.until) return cached.token;
    const secret =
      connection.credentialSource === 'environment'
        ? process.env[connection.secretEnvironmentVariable]
        : await protectSecret(connection.protectedSecret, true);
    if (!secret) throw new Error('Connection credential is unavailable.');
    let response;
    try {
      response = await fetchImpl(endpoint.href, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        body: new URLSearchParams({
          client_id: connection.clientId,
          client_secret: secret,
          grant_type: 'client_credentials',
          scope: `${origin}/.default`,
        }),
      });
    } catch {
      throw new Error('Application token request failed (network/timeout); credential details withheld.');
    }
    if (!response.ok)
      throw new Error(`Application token request failed (HTTP ${response.status}); credential response withheld.`);
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error('Invalid token response; credential details withheld.');
    }
    if (typeof body.access_token !== 'string' || !Number.isFinite(Number(body.expires_in)))
      throw new Error('Invalid token response.');
    cached = { token: body.access_token, until: Date.now() + Math.max(0, Number(body.expires_in) - 120) * 1000 };
    return cached.token;
  };
}
