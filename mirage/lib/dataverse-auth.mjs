// Entra ID (AAD) authority for the Dataverse simulator: RS256 signing key, OIDC metadata, client
// authentication, client_credentials and refresh_token grants, AADSTS error envelopes.
// Milestone 1: authorization_code, device_code, password and on-behalf-of answer AADSTS70003, and the
// interactive endpoints answer 501 until milestone 2.
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, timingSafeEqual, verify } from "node:crypto";

const DATAVERSE_APP_ID = "00000007-0000-0000-c000-000000000000";
const SUPPORTED_GRANTS = ["client_credentials", "refresh_token"];
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const SKEW_SECONDS = 300;
const REFRESH_LIFETIME_MS = 24 * 60 * 60 * 1000;
const OIDC_SCOPES = new Set(["openid", "profile", "offline_access"]);
const TOKEN_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", pragma: "no-cache" };
// AADSTS code -> [error, HTTP status]. Every code answers 400 except a wrong client secret (401).
const AAD_ERRORS = {
  90002: ["invalid_request", 400],
  500011: ["invalid_resource", 400],
  700016: ["unauthorized_client", 400],
  700027: ["invalid_client", 400],
  700082: ["invalid_grant", 400],
  70003: ["unsupported_grant_type", 400],
  70011: ["invalid_scope", 400],
  900144: ["invalid_request", 400],
  9002313: ["invalid_grant", 400],
  7000215: ["invalid_client", 401],
  7000218: ["invalid_client", 400],
  7000222: ["invalid_client", 400],
};
const CLAIMS_SUPPORTED = ["sub", "iss", "cloud_instance_name", "cloud_instance_host_name", "cloud_graph_host_name", "msgraph_host", "aud", "exp", "iat", "auth_time", "acr", "nonce", "preferred_username", "name", "tid", "ver", "at_hash", "c_hash", "email"];

const b64json = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const fromB64json = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const timestamp = (ms) => `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")}Z`;
const safeDecode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
const digest = (salt, secret) => createHash("sha256").update(salt).update(String(secret)).digest();
const verifies = (data, signature, key) => {
  try {
    return verify("sha256", Buffer.from(data), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
};
// Object id in UUID v5 layout, derived from a seed (service principal ids are deterministic per app).
const guid = (seed) => {
  const bytes = createHash("sha1").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const secretExpiry = (value) => (value == null ? Infinity : new Date(value).getTime());
const parseBasic = (authorization) => {
  const match = /^Basic\s+(\S+)$/i.exec(authorization ?? "");
  if (!match) return null;
  const [id, ...secret] = Buffer.from(match[1], "base64").toString("utf8").split(":");
  return { clientId: safeDecode(id), secret: safeDecode(secret.join(":")) };
};
const acceptedResource = (value, origin) => [origin, `${origin}/`].includes(value) || String(value).toLowerCase() === DATAVERSE_APP_ID;
// The one resource named by a scope string (OIDC scopes ignored); null when empty, mixed, or not accepted.
const scopeResource = (scope, origin, defaultOnly) => {
  let resource = null;
  for (const item of String(scope).split(/\s+/).filter(Boolean)) {
    if (OIDC_SCOPES.has(item)) continue;
    const match = /^(.+)\/(\.default|user_impersonation)$/.exec(item);
    if (!match || (defaultOnly && match[2] !== ".default") || !acceptedResource(match[1], origin) || (resource && resource !== match[1])) return null;
    resource = match[1];
  }
  return resource;
};
const notImplemented = () => ({ status: 501, body: "Not implemented in this milestone", headers: { "content-type": "text/plain" } });

export const handleAuthorize = notImplemented;
export const handleDeviceCode = notImplemented;
export const handleDeviceVerification = notImplemented;

export function hashSecret(secret, salt = randomBytes(16)) {
  return { hash: digest(salt, secret).toString("base64url"), salt: salt.toString("base64url") };
}

export function verifySecret(secret, { hash, salt } = {}) {
  if (!hash || !salt) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = digest(Buffer.from(salt, "base64url"), secret);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const newClientSecret = () => randomBytes(30).toString("base64url");

export function aadError(code, { status, description = "", origin, traceId = randomUUID(), correlationId = randomUUID(), now = Date.now() } = {}) {
  const [error, defaultStatus] = AAD_ERRORS[code] ?? ["invalid_request", 400];
  const time = timestamp(now);
  return {
    status: status ?? defaultStatus,
    body: {
      error,
      error_description: `AADSTS${code}: ${description} Trace ID: ${traceId} Correlation ID: ${correlationId} Timestamp: ${time}`,
      error_codes: [code],
      timestamp: time,
      trace_id: traceId,
      correlation_id: correlationId,
      ...(origin ? { error_uri: `${origin}/error?code=${code}` } : {}),
    },
  };
}

export function createAuthority({ tenantId, applications, users, clock = () => Date.now(), accessTokenLifetimeSeconds = 3600 }) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const { kty, n, e } = publicKey.export({ format: "jwk" });
  // kid doubles as x5t: base64url of the SHA-1 of the DER SPKI (no X.509 certificate exists for this key).
  const kid = createHash("sha1").update(publicKey.export({ type: "spki", format: "der" })).digest("base64url");
  const refreshTokens = new Map();
  const knownTenant = (segment) => ["common", "organizations", "consumers", tenantId.toLowerCase()].includes(String(segment).toLowerCase());

  const signJwt = (claims) => {
    const head = b64json({ typ: "JWT", alg: "RS256", kid, x5t: kid });
    const body = b64json(claims);
    return `${head}.${body}.${sign("sha256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
  };

  // Access tokens are always v1.0 format, which Dataverse accepts regardless of the endpoint version.
  const issueAccessToken = ({ origin, appId, audience, user, appidacr = "1", now = clock() }) => {
    const iat = Math.floor(now / 1000);
    const oid = user ? user.azureactivedirectoryobjectid : guid(`sp:${appId.toLowerCase()}`);
    return signJwt({
      aud: audience,
      iss: `${origin}/${tenantId}/`,
      iat,
      nbf: iat,
      exp: iat + accessTokenLifetimeSeconds,
      appid: appId,
      appidacr,
      idtyp: user ? "user" : "app",
      oid,
      sub: oid,
      tid: tenantId,
      ver: "1.0",
      uti: randomBytes(12).toString("base64url"),
      ...(user ? { name: user.fullname, upn: user.domainname, unique_name: user.domainname, given_name: user.firstname, family_name: user.lastname, scp: "user_impersonation", amr: ["pwd"] } : {}),
    });
  };

  const issueRefreshToken = ({ appId, oid, resource, scope, now = clock() }) => {
    const token = randomBytes(36).toString("base64url");
    refreshTokens.set(token, { appId: appId.toLowerCase(), oid, resource, scope, expiresAt: now + REFRESH_LIFETIME_MS });
    return token;
  };

  const tokenBody = ({ version, access, now, audience, scope, refresh }) => {
    const iat = Math.floor(now / 1000);
    const refreshField = refresh ? { refresh_token: refresh } : {};
    if (version === "v1.0") {
      return { token_type: "Bearer", expires_in: String(accessTokenLifetimeSeconds), ext_expires_in: String(accessTokenLifetimeSeconds), expires_on: String(iat + accessTokenLifetimeSeconds), not_before: String(iat), resource: audience, access_token: access, ...refreshField };
    }
    return { token_type: "Bearer", ...(scope ? { scope } : {}), expires_in: accessTokenLifetimeSeconds, ext_expires_in: accessTokenLifetimeSeconds, access_token: access, ...refreshField };
  };

  const verifyAssertion = (app, form, { origin, tenantSegment, now }) => {
    const reject = (description) => ({ code: 700027, description });
    if (form.client_assertion_type !== ASSERTION_TYPE || !form.client_assertion) return reject(`The client assertion must be of type ${ASSERTION_TYPE}.`);
    const [head, body, signature] = String(form.client_assertion).split(".");
    let header;
    let claims;
    try {
      header = fromB64json(head);
      claims = fromB64json(body);
    } catch {
      return reject("The client assertion is not a JSON Web Token.");
    }
    const x5t = Buffer.from(String(header.x5t ?? ""), "base64url").toString("hex").toUpperCase();
    const cert = (app.certificates ?? []).find((item) => item.thumbprint.toUpperCase() === x5t);
    if (header.alg !== "RS256" || !cert) return reject("The client assertion is not signed with a registered certificate.");
    if (!verifies(`${head}.${body}`, signature, cert.publicKeyPem)) return reject("The client assertion signature is invalid.");
    const subject = app.appId.toLowerCase();
    if (String(claims.iss).toLowerCase() !== subject || String(claims.sub).toLowerCase() !== subject) return reject("The client assertion's iss and sub must be the client_id.");
    const endpoints = [tenantSegment, tenantId].flatMap((segment) => [`${origin}/${segment}/oauth2/v2.0/token`, `${origin}/${segment}/oauth2/token`]);
    if (![claims.aud].flat().some((item) => endpoints.includes(item))) return reject("The client assertion's audience is not this token endpoint.");
    const nowSeconds = now / 1000;
    if (!(Number(claims.exp) > nowSeconds - SKEW_SECONDS) || Number(claims.exp) > nowSeconds + 600) return reject("The client assertion has expired or lasts longer than 10 minutes.");
    return { appidacr: "2" };
  };

  // Returns { appidacr } on success or { code, description } on failure.
  const authenticateClient = (app, form, basic, ctx) => {
    if (form.client_assertion || form.client_assertion_type) return verifyAssertion(app, form, ctx);
    const secret = form.client_secret ?? basic?.secret;
    if (secret === undefined) {
      if (app.publicClient) return { appidacr: "0" };
      return { code: 7000218, description: "The request body must contain the following parameter: 'client_secret' or 'client_assertion'." };
    }
    const match = (app.secrets ?? []).find((item) => verifySecret(secret, item));
    if (!match) return { code: 7000215, description: `Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID, for a secret added to app '${app.appId}'.` };
    if (secretExpiry(match.expiresOn) <= ctx.now) return { code: 7000222, description: "The provided client secret keys are expired. Visit the Azure portal to create new keys for your app." };
    return { appidacr: "1" };
  };

  const handleToken = ({ origin, tenantSegment, form = {}, headers = {}, version = "v2.0" }) => {
    const now = clock();
    const reply = (result) => ({ ...result, headers: { ...TOKEN_HEADERS } });
    const failure = (code, description) => reply(aadError(code, { description, origin, now }));
    if (!knownTenant(tenantSegment)) return failure(90002, `Tenant '${tenantSegment}' not found. Check to make sure you have the correct tenant ID and are signing into the correct cloud.`);
    if (!form.grant_type) return failure(900144, "The request body must contain the following parameter: 'grant_type'.");
    if (!SUPPORTED_GRANTS.includes(form.grant_type)) return failure(70003, `The app requested an unsupported grant type '${form.grant_type}'.`);
    const basic = parseBasic(headers.authorization);
    const clientId = form.client_id ?? basic?.clientId;
    if (!clientId) return failure(900144, "The request body must contain the following parameter: 'client_id'.");
    const app = applications().find((item) => item.appId.toLowerCase() === String(clientId).toLowerCase());
    if (!app) return failure(700016, `Application with identifier '${clientId}' was not found in the directory '${tenantId}'. This can happen if the application has not been installed by the administrator of the tenant or consented to by any user in the tenant. You may have sent your authentication request to the wrong tenant.`);
    if (!(app.allowedGrants ?? SUPPORTED_GRANTS).includes(form.grant_type)) return failure(700016, `The client is not permitted to use the grant type '${form.grant_type}'.`);
    const auth = authenticateClient(app, form, basic, { origin, tenantSegment, now });
    if (auth.code) return failure(auth.code, auth.description);

    if (form.grant_type === "refresh_token") {
      if (!form.refresh_token) return failure(900144, "The request body must contain the following parameter: 'refresh_token'.");
      const entry = refreshTokens.get(form.refresh_token);
      if (!entry || entry.appId !== app.appId.toLowerCase()) return failure(9002313, "Invalid request. Request is malformed or invalid.");
      refreshTokens.delete(form.refresh_token);
      if (entry.expiresAt <= now) return failure(700082, "The refresh token has expired due to inactivity.");
      const user = users.byObjectId(entry.oid);
      if (!user) return failure(9002313, "Invalid request. Request is malformed or invalid.");
      const refresh = issueRefreshToken({ appId: app.appId, oid: entry.oid, resource: entry.resource, scope: entry.scope, now });
      const access = issueAccessToken({ origin, appId: app.appId, audience: entry.resource, user, appidacr: auth.appidacr, now });
      return reply({ status: 200, body: tokenBody({ version, access, now, audience: entry.resource, scope: entry.scope, refresh }) });
    }

    let resource;
    if (version === "v1.0") {
      if (!form.resource) return failure(900144, "The request body must contain the following parameter: 'resource'.");
      if (!acceptedResource(form.resource, origin)) return failure(500011, `The resource '${form.resource}' was not found in the directory '${tenantId}'.`);
      resource = form.resource;
    } else {
      if (!form.scope) return failure(900144, "The request body must contain the following parameter: 'scope'.");
      resource = scopeResource(form.scope, origin, true);
      if (!resource) return failure(70011, "The provided value for the input parameter 'scope' isn't valid. The scope must name exactly one resource and end in '/.default'.");
    }
    const access = issueAccessToken({ origin, appId: app.appId, audience: resource, appidacr: auth.appidacr, now });
    return reply({ status: 200, body: tokenBody({ version, access, now, audience: resource }) });
  };

  const verifyBearer = (header, { origin, tenantId: tenant = tenantId } = {}) => {
    if (!header) return { ok: false, reason: "missing" };
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const parts = match ? match[1].split(".") : [];
    if (parts.length !== 3) return { ok: false, reason: "malformed" };
    let jwtHeader;
    let claims;
    try {
      jwtHeader = fromB64json(parts[0]);
      claims = fromB64json(parts[1]);
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (jwtHeader.alg !== "RS256") return { ok: false, reason: "malformed" };
    if (!verifies(`${parts[0]}.${parts[1]}`, parts[2], publicKey)) return { ok: false, reason: "signature" };
    if (Number(claims.exp) + SKEW_SECONDS < clock() / 1000) return { ok: false, reason: "expired" };
    const audienceOk = [claims.aud].flat().some((item) => item === origin || item === `${origin}/` || String(item).toLowerCase() === DATAVERSE_APP_ID);
    if (!audienceOk) return { ok: false, reason: "audience" };
    if (claims.iss !== `${origin}/${tenant}/`) return { ok: false, reason: "issuer" };
    if (claims.tid !== tenant) return { ok: false, reason: "tenant" };
    return { ok: true, claims };
  };

  const openIdConfiguration = (origin, version = "v2.0") => {
    const v2 = version !== "v1.0";
    const base = `${origin}/${tenantId}`;
    const oauth = v2 ? `${base}/oauth2/v2.0` : `${base}/oauth2`;
    return {
      authorization_endpoint: `${oauth}/authorize`,
      token_endpoint: `${oauth}/token`,
      device_authorization_endpoint: `${oauth}/devicecode`,
      jwks_uri: `${base}/${v2 ? "discovery/v2.0" : "discovery"}/keys`,
      end_session_endpoint: `${oauth}/logout`,
      userinfo_endpoint: `${origin}/oidc/userinfo`,
      issuer: v2 ? `${base}/v2.0` : `${base}/`,
      token_endpoint_auth_methods_supported: ["client_secret_post", "private_key_jwt", "client_secret_basic"],
      response_modes_supported: ["query", "fragment", "form_post"],
      response_types_supported: ["code", "id_token", "code id_token", "id_token token"],
      scopes_supported: v2 ? ["openid", "profile", "email", "offline_access"] : ["openid"],
      claims_supported: CLAIMS_SUPPORTED,
      subject_types_supported: ["pairwise"],
      id_token_signing_alg_values_supported: ["RS256"],
      request_uri_parameter_supported: false,
      http_logout_supported: true,
      frontchannel_logout_supported: true,
      tenant_region_scope: null,
      cloud_instance_name: "microsoftonline.com",
      cloud_graph_host_name: "graph.windows.net",
      msgraph_host: "graph.microsoft.com",
      rbac_url: "https://pas.windows.net",
    };
  };

  const instanceDiscovery = (origin) => {
    const host = new URL(origin).host;
    return {
      tenant_discovery_endpoint: `${origin}/${tenantId}/v2.0/.well-known/openid-configuration`,
      "api-version": "1.1",
      metadata: [{ preferred_network: host, preferred_cache: host, aliases: [host] }],
    };
  };

  return {
    kid,
    jwks: () => ({ keys: [{ kty, use: "sig", kid, alg: "RS256", n, e }] }),
    openIdConfiguration,
    instanceDiscovery,
    handleToken,
    handleAuthorize,
    handleDeviceCode,
    handleDeviceVerification,
    issueAccessToken,
    issueRefreshToken,
    verifyBearer,
  };
}
