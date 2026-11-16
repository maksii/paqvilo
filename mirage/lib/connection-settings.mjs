// The `connections` settings contract: validation only, no connector runtime. connector-runtime.mjs re-exports
// connectionSettings; settings-contracts.mjs registers the parser on the config-load path.

const isMap = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const CREDENTIAL = /secret|password|key|token/i;
/** A credential reference: `env:NAME` or `variable:NAME`, never a literal. */
export const CONNECTION_REFERENCE = /^(?:env|variable):[A-Za-z_][\w.-]*$/;
function credentialFree(value, label, depth = 0) {
  if (depth > 16) throw new Error(`${label} nests too deeply`);
  if (Array.isArray(value)) return value.forEach((item, i) => credentialFree(item, `${label}[${i}]`, depth + 1));
  if (!isMap(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (CREDENTIAL.test(key) && typeof item === 'string' && !CONNECTION_REFERENCE.test(item))
      throw new Error(`${label}.${key} must not hold a credential; use an env:NAME or variable: reference`);
    credentialFree(item, `${label}.${key}`, depth + 1);
  }
}
const PROVIDER = /^(?:dataverse|http|fixture|memory-queue|approvals|pack:[\w.-]+|custom-connector:[\w.-]+)$/;
const AUTH_KEYS = ['apiKey', 'username', 'password', 'token', 'clientId', 'clientSecret'];
function validateConnectionPrincipalAndEvidence(entry, at) {
  const principal = entry.principal;
  if (
    principal !== undefined &&
    !(typeof principal === 'string' && principal.trim()) &&
    !(
      isMap(principal) &&
      Object.keys(principal).every((key) => ['pack', 'identity'].includes(key)) &&
      typeof principal.identity === 'string' &&
      principal.identity.trim() &&
      (principal.pack === undefined || typeof principal.pack === 'string')
    )
  )
    throw new Error(`${at}.principal must name a pack connection principal ({ pack, identity } or a name)`);
  if (entry.evidence !== undefined && typeof entry.evidence !== 'string')
    throw new Error(`${at}.evidence must be text`);
}

function validateConnectionAuth(at, auth) {
  if (
    auth !== undefined &&
    (!isMap(auth) ||
      Object.entries(auth).some(
        ([key, value]) => !AUTH_KEYS.includes(key) || typeof value !== 'string' || !CONNECTION_REFERENCE.test(value),
      ))
  )
    throw new Error(`${at}.settings.auth takes ${AUTH_KEYS.join(', ')} as env:NAME or variable:NAME references only`);
}

function validateConnectionParameters(at, parameters) {
  if (
    parameters !== undefined &&
    (!isMap(parameters) ||
      Object.values(parameters).some((value) => !['string', 'number', 'boolean'].includes(typeof value)))
  )
    throw new Error(`${at}.settings.parameters must map connection parameter names to text, numbers or booleans`);
}

function validateConnectionRewrites(at, rewrites) {
  if (!isMap(rewrites)) throw new Error(`${at}.settings.rewrites must map URL prefixes to local URL prefixes`);
  for (const [from, to] of Object.entries(rewrites))
    for (const url of [from, to]) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`${at}.settings.rewrites needs absolute http(s) URL prefixes`);
      }
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      )
        throw new Error(
          `${at}.settings.rewrites prefixes must be plain http(s) URLs without credentials, query or fragment`,
        );
    }
}

function validateConnectionSettings(entry, at) {
  const settings = entry.settings ?? {};
  if (!isMap(settings)) throw new Error(`${at}.settings must be an object`);
  for (const key of Object.keys(settings))
    if (!['rewrites', 'auth', 'parameters'].includes(key))
      throw new Error(`${at}.settings.${key} is not a connection setting`);
  validateConnectionAuth(at, settings.auth);
  validateConnectionParameters(at, settings.parameters);
  validateConnectionRewrites(at, settings.rewrites ?? {});
  return settings;
}

/** Validates the project `connections` map; returns a plain copy. Credentials are never accepted as literals. */
/* NOSONAR */ export function connectionSettings(value, label = 'connections') {
  if (value === undefined) return {};
  if (!isMap(value)) throw new Error(`${label} must map connection ids to local connections`);
  const result = {};
  for (const [id, entry] of Object.entries(value)) {
    const at = `${label}.${id}`;
    if (!id.trim() || id.length > 250 || ['__proto__', 'constructor', 'prototype'].includes(id))
      throw new Error(`${label} has an invalid connection id`);
    if (!isMap(entry)) throw new Error(`${at} must be an object`);
    for (const key of Object.keys(entry))
      if (!['connector', 'provider', 'principal', 'evidence', 'settings'].includes(key))
        throw new Error(`${at}.${key} is not a connection setting`);
    if (
      entry.connector !== undefined &&
      (typeof entry.connector !== 'string' || !/^[\w.-]{1,250}$/.test(entry.connector))
    )
      throw new Error(`${at}.connector must be a connector id`);
    if (entry.provider !== undefined && (typeof entry.provider !== 'string' || !PROVIDER.test(entry.provider)))
      throw new Error(
        `${at}.provider must be dataverse, http, fixture, memory-queue, approvals, pack:<id> or custom-connector:<name>`,
      );
    validateConnectionPrincipalAndEvidence(entry, at);
    const settings = validateConnectionSettings(entry, at);
    credentialFree({ principal: entry.principal, evidence: entry.evidence, parameters: settings.parameters }, at);
    result[id] = structuredClone(entry);
  }
  return result;
}

/** The parser the config-key registry holds for `connections`: an absent key stays absent. */
export const connectionsSettingParser = (value, label) => (value == null ? value : connectionSettings(value, label));
