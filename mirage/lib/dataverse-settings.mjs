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
const TOP_KEYS = ['enabled', 'port', 'tls', 'tlsPort', 'tenantId', 'organizationId', 'uniqueName', 'friendlyName', 'version', 'applications', 'users', 'serviceProtection'];
const APPLICATION_KEYS = ['appId', 'displayName', 'secretEnvironmentVariable', 'roles', 'publicClient', 'redirectUris', 'allowedGrants'];
const USER_KEYS = ['domainname', 'fullname', 'objectId', 'roles'];

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
  return {
    appId: guid(required(value.appId, `${label}.appId`), `${label}.appId`),
    displayName: text(required(value.displayName, `${label}.displayName`), `${label}.displayName`, null),
    secretEnvironmentVariable,
    roles: textList(value.roles, `${label}.roles`, ['System Administrator']),
    publicClient: boolean(value.publicClient, `${label}.publicClient`, false),
    redirectUris: [...redirectUris],
    allowedGrants: [...new Set(allowedGrants.map(grantName))],
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

function serviceProtection(value) {
  if (value === undefined || value === null) return null;
  plainObject(value, 'dataverse.serviceProtection');
  knownKeys(value, ['requestsPer300s'], 'dataverse.serviceProtection');
  return { requestsPer300s: integer(required(value.requestsPer300s, 'dataverse.serviceProtection.requestsPer300s'), 'dataverse.serviceProtection.requestsPer300s', null, 1, Number.MAX_SAFE_INTEGER) };
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
  };
}
