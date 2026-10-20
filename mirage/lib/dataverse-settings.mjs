import { uuidV5 } from './dataverse-security.mjs';

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Setting names mapped to their wire form on the token endpoint (grant_type values).
export const GRANT_TYPES = {
  client_credentials: 'client_credentials',
  authorization_code: 'authorization_code',
  device_code: 'urn:ietf:params:oauth:grant-type:device_code',
  refresh_token: 'refresh_token',
  password: 'password',
  on_behalf_of: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
};
const GRANTS = Object.keys(GRANT_TYPES);
// Namespace for the default user objectId (the RFC 4122 DNS namespace).
const USER_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
// The audience a federated identity credential accepts (Microsoft Entra workload identity federation).
const TOKEN_EXCHANGE_AUDIENCE = 'api://AzureADTokenExchange';
const TOP_KEYS = ['enabled', 'port', 'tls', 'tlsPort', 'tenantId', 'organizationId', 'uniqueName', 'friendlyName', 'version', 'applications', 'users', 'serviceProtection', 'managedIdentities', 'federatedIssuers', 'auditing', 'duplicateDetection', 'pluginTimeoutSeconds', 'currencyCode', 'currencySymbol', 'localeId', 'tds', 'gitRemoteDirectory'];
const APPLICATION_KEYS = ['appId', 'displayName', 'secretEnvironmentVariable', 'roles', 'publicClient', 'redirectUris', 'allowedGrants', 'federatedCredentials'];
const USER_KEYS = ['domainname', 'fullname', 'objectId', 'roles'];
const FEDERATED_CREDENTIAL_KEYS = ['issuer', 'subject', 'audiences'];
const MANAGED_IDENTITY_KEYS = ['clientId', 'principalId', 'displayName', 'roles'];
const FEDERATED_ISSUER_KEYS = ['issuer', 'jwks'];
const SERVICE_PROTECTION_KEYS = ['requestsPer300s', 'executionMsPer300s', 'executionTimeMsPer300s', 'concurrentRequests'];
const TDS_KEYS = ['enabled', 'port'];

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function knownKeys(value, keys, label) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label}.${key} is not a supported setting`);
}

function required(value, label) {
  if (value === undefined) throw new Error(`${label} is required`);
  return value;
}

// The setting name for a grant given as its name or its URN wire form; null when unknown.
const grantName = (value) => GRANTS.find((name) => name === value || GRANT_TYPES[name] === value) ?? null;

// True when the application may use the grant (a missing allowedGrants list allows all); names and URN forms both match.
export function grantAllowed(app, grantType) {
  const wanted = grantName(grantType);
  if (wanted === null) return false;
  return (app.allowedGrants ?? GRANTS).some((grant) => grantName(grant) === wanted);
}

function guid(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !GUID_PATTERN.test(value)) throw new Error(`${label} must be a GUID`);
  return value.toLowerCase();
}

function integer(value, label, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
  return value;
}

function boolean(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false`);
  return value;
}

function text(value, label, fallback, pattern = null) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be non-empty text`);
  if (pattern && !pattern.test(value)) throw new Error(`${label} must match ${pattern}`);
  return value;
}

function textList(value, label, fallback) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`${label} must be an array of non-empty text`);
  return [...value];
}

// An http(s) URL, returned unchanged: issuers are compared with the token's iss claim exactly.
function httpUrl(value, label) {
  try {
    if (['http:', 'https:'].includes(new URL(value).protocol)) return value;
  } catch {
    // reported below
  }
  throw new Error(`${label} must be an http(s) URL`);
}

function application(value, label) {
  plainObject(value, label);
  for (const key of ['secret', 'clientSecret']) if (key in value) throw new Error(`${label}.${key}: secrets must come from secretEnvironmentVariable, never from configuration`);
  knownKeys(value, APPLICATION_KEYS, label);
  const redirectUris = value.redirectUris === undefined ? [] : value.redirectUris;
  if (!Array.isArray(redirectUris)) throw new Error(`${label}.redirectUris must be an array of http(s) URLs`);
  redirectUris.forEach((uri, index) => {
    let url;
    try { url = new URL(uri); } catch { throw new Error(`${label}.redirectUris[${index}] must be an http(s) URL`); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label}.redirectUris[${index}] must be an http(s) URL`);
  });
  const allowedGrants = value.allowedGrants === undefined ? [...GRANTS] : value.allowedGrants;
  if (!Array.isArray(allowedGrants) || allowedGrants.some((grant) => grantName(grant) === null)) throw new Error(`${label}.allowedGrants must be a subset of ${GRANTS.join(', ')}`);
  const secretEnvironmentVariable = text(value.secretEnvironmentVariable, `${label}.secretEnvironmentVariable`, null, /^[A-Z_][A-Z0-9_]*$/);
  const federated = value.federatedCredentials === undefined ? [] : value.federatedCredentials;
  if (!Array.isArray(federated)) throw new Error(`${label}.federatedCredentials must be an array`);
  return {
    appId: guid(required(value.appId, `${label}.appId`), `${label}.appId`),
    displayName: text(required(value.displayName, `${label}.displayName`), `${label}.displayName`, null),
    secretEnvironmentVariable,
    // Entra application users hold no roles until they are assigned, so an application without roles has none.
    roles: textList(value.roles, `${label}.roles`, []),
    publicClient: boolean(value.publicClient, `${label}.publicClient`, false),
    redirectUris: [...redirectUris],
    allowedGrants: [...new Set(allowedGrants.map(grantName))],
    federatedCredentials: federated.map((item, index) => federatedCredential(item, `${label}.federatedCredentials[${index}]`)),
  };
}

// Entra workload identity federation: an external issuer's subject, trusted for one audience.
function federatedCredential(value, label) {
  plainObject(value, label);
  knownKeys(value, FEDERATED_CREDENTIAL_KEYS, label);
  const audiences = textList(value.audiences, `${label}.audiences`, [TOKEN_EXCHANGE_AUDIENCE]);
  if (audiences.length !== 1) throw new Error(`${label}.audiences must contain exactly one audience`);
  return {
    issuer: httpUrl(required(value.issuer, `${label}.issuer`), `${label}.issuer`),
    subject: text(required(value.subject, `${label}.subject`), `${label}.subject`, null),
    audiences,
  };
}

// An external issuer whose public keys (JWKS) verify federated client assertions.
function federatedIssuer(value, label) {
  plainObject(value, label);
  knownKeys(value, FEDERATED_ISSUER_KEYS, label);
  const jwks = plainObject(required(value.jwks, `${label}.jwks`), `${label}.jwks`);
  knownKeys(jwks, ['keys'], `${label}.jwks`);
  if (!Array.isArray(jwks.keys) || jwks.keys.some((key) => !key || typeof key !== 'object' || Array.isArray(key))) throw new Error(`${label}.jwks.keys must be an array of JSON Web Keys`);
  if (jwks.keys.some((key) => 'd' in key)) throw new Error(`${label}.jwks.keys must hold public keys only`);
  return { issuer: httpUrl(required(value.issuer, `${label}.issuer`), `${label}.issuer`), jwks: { keys: jwks.keys.map((key) => ({ ...key })) } };
}

// A managed identity becomes an application user; its clientId is the token's appid.
function managedIdentity(value, label) {
  plainObject(value, label);
  knownKeys(value, MANAGED_IDENTITY_KEYS, label);
  return {
    clientId: guid(required(value.clientId, `${label}.clientId`), `${label}.clientId`),
    principalId: guid(value.principalId, `${label}.principalId`),
    displayName: text(required(value.displayName, `${label}.displayName`), `${label}.displayName`, null),
    roles: textList(value.roles, `${label}.roles`, ['Basic User']),
  };
}

function user(value, label) {
  plainObject(value, label);
  knownKeys(value, USER_KEYS, label);
  const domainname = text(required(value.domainname, `${label}.domainname`), `${label}.domainname`, null, /^[^\s@]+@[^\s@]+$/);
  return {
    domainname,
    fullname: text(required(value.fullname, `${label}.fullname`), `${label}.fullname`, null),
    // Deterministic per domain name, so the same configuration always yields the same Entra object id.
    objectId: guid(value.objectId, `${label}.objectId`) ?? uuidV5(USER_NAMESPACE, `paqvilo-dataverse-user:${domainname.toLowerCase()}`),
    roles: textList(value.roles, `${label}.roles`, ['Basic User']),
  };
}

// Limits use the key names of dataverse-limits.mjs; executionTimeMsPer300s is accepted as an alias of executionMsPer300s.
function serviceProtection(value) {
  if (value === undefined || value === null) return null;
  plainObject(value, 'dataverse.serviceProtection');
  knownKeys(value, SERVICE_PROTECTION_KEYS, 'dataverse.serviceProtection');
  const bound = 'dataverse.serviceProtection';
  const { executionMsPer300s, executionTimeMsPer300s } = value;
  if (executionMsPer300s !== undefined && executionTimeMsPer300s !== undefined && executionMsPer300s !== executionTimeMsPer300s) throw new Error(`${bound}.executionTimeMsPer300s must equal executionMsPer300s when both are set`);
  const executionKey = executionMsPer300s !== undefined ? 'executionMsPer300s' : 'executionTimeMsPer300s';
  const max = Number.MAX_SAFE_INTEGER;
  return {
    requestsPer300s: integer(value.requestsPer300s, `${bound}.requestsPer300s`, null, 1, max),
    executionMsPer300s: integer(executionMsPer300s ?? executionTimeMsPer300s, `${bound}.${executionKey}`, null, 1, max),
    concurrentRequests: integer(value.concurrentRequests, `${bound}.concurrentRequests`, null, 1, max),
  };
}

// "Enable TDS endpoint" is on by default in Dataverse. Port 0 is ephemeral; 1433 and 5558 are opt-in.
function tds(value, label) {
  if (value === undefined) return { enabled: true, port: 0 };
  plainObject(value, label);
  knownKeys(value, TDS_KEYS, label);
  return { enabled: boolean(value.enabled, `${label}.enabled`, true), port: integer(value.port, `${label}.port`, 0, 0, 65535) };
}

export function dataverseSettings(value, label = 'dataverse') {
  if (value === undefined || value === false) return { enabled: false };
  const input = value === true ? {} : plainObject(value, label);
  knownKeys(input, TOP_KEYS, label);
  const list = (items, name) => {
    if (items === undefined) return [];
    if (!Array.isArray(items)) throw new Error(`${label}.${name} must be an array`);
    return items;
  };
  return {
    enabled: boolean(input.enabled, `${label}.enabled`, true),
    port: integer(input.port, `${label}.port`, 0, 0, 65535),
    tls: boolean(input.tls, `${label}.tls`, false),
    tlsPort: integer(input.tlsPort, `${label}.tlsPort`, 0, 0, 65535),
    tenantId: guid(input.tenantId, `${label}.tenantId`),
    organizationId: guid(input.organizationId, `${label}.organizationId`),
    uniqueName: text(input.uniqueName, `${label}.uniqueName`, 'orgsim', /^[a-z][a-z0-9]{1,23}$/),
    friendlyName: text(input.friendlyName, `${label}.friendlyName`, 'Simulated environment'),
    version: text(input.version, `${label}.version`, '9.2.25041.00000', /^\d+\.\d+\.\d+\.\d+$/),
    applications: list(input.applications, 'applications').map((item, index) => application(item, `${label}.applications[${index}]`)),
    users: list(input.users, 'users').map((item, index) => user(item, `${label}.users[${index}]`)),
    serviceProtection: serviceProtection(input.serviceProtection),
    managedIdentities: list(input.managedIdentities, 'managedIdentities').map((item, index) => managedIdentity(item, `${label}.managedIdentities[${index}]`)),
    federatedIssuers: list(input.federatedIssuers, 'federatedIssuers').map((item, index) => federatedIssuer(item, `${label}.federatedIssuers[${index}]`)),
    // organization.isauditenabled, organization.isduplicatedetectionenabled and the base currency and locale of the organization.
    auditing: boolean(input.auditing, `${label}.auditing`, false),
    duplicateDetection: boolean(input.duplicateDetection, `${label}.duplicateDetection`, true),
    // The plug-in execution limit of a custom API's handler; the platform's sandbox limit is 2 minutes.
    pluginTimeoutSeconds: integer(input.pluginTimeoutSeconds, `${label}.pluginTimeoutSeconds`, 120, 1, 3600),
    currencyCode: text(input.currencyCode, `${label}.currencyCode`, 'USD', /^[A-Z]{3}$/),
    currencySymbol: text(input.currencySymbol, `${label}.currencySymbol`, '$'),
    localeId: integer(input.localeId, `${label}.localeId`, 1033, 1, 65535),
    tds: tds(input.tds, `${label}.tds`),
    // A local directory standing in for the Git remote of source control (dataverse-addon-git.mjs); resolved by server.mjs.
    gitRemoteDirectory: text(input.gitRemoteDirectory, `${label}.gitRemoteDirectory`, null),
  };
}

export function dataverseStatus(settings, runtime = {}) {
  return {
    enabled: settings.enabled === true,
    origin: runtime.origin ?? null,
    tlsOrigin: runtime.tlsOrigin ?? null,
    authority: runtime.authority ?? null,
    tenantId: settings.tenantId ?? runtime.tenantId ?? null,
    organizationId: settings.organizationId ?? runtime.organizationId ?? null,
    uniqueName: settings.uniqueName ?? null,
    version: settings.version ?? null,
    // The listening TDS port (null when the endpoint is disabled).
    tdsPort: runtime.tdsPort ?? null,
  };
}
