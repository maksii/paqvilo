const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRANTS = ['client_credentials', 'authorization_code', 'device_code', 'refresh_token', 'password', 'on_behalf_of'];
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
  if (!Array.isArray(allowedGrants) || allowedGrants.some((grant) => !GRANTS.includes(grant))) throw new Error(`${label}.allowedGrants must be a subset of ${GRANTS.join(', ')}`);
  const secretEnvironmentVariable = text(value.secretEnvironmentVariable, `${label}.secretEnvironmentVariable`, null, /^[A-Z_][A-Z0-9_]*$/);
  return {
    appId: guid(required(value.appId, `${label}.appId`), `${label}.appId`),
    displayName: text(required(value.displayName, `${label}.displayName`), `${label}.displayName`, null),
    secretEnvironmentVariable,
    roles: textList(value.roles, `${label}.roles`, ['System Administrator']),
    publicClient: boolean(value.publicClient, `${label}.publicClient`, false),
    redirectUris: [...redirectUris],
    allowedGrants: [...allowedGrants],
  };
}

function user(value, label) {
  plainObject(value, label);
  knownKeys(value, USER_KEYS, label);
  return {
    domainname: text(required(value.domainname, `${label}.domainname`), `${label}.domainname`, null, /^[^\s@]+@[^\s@]+$/),
    fullname: text(required(value.fullname, `${label}.fullname`), `${label}.fullname`, null),
    objectId: guid(value.objectId, `${label}.objectId`),
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
