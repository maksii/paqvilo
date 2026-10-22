// Entra ID (AAD) authority for the Dataverse simulator: RS256 signing key, OIDC metadata, client
// authentication, client_credentials, authorization_code (PKCE), device_code, password (ROPC),
// on-behalf-of and refresh_token grants, the interactive user pages, and AADSTS error envelopes.
import { X509Certificate, constants, createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, scryptSync, sign, timingSafeEqual, verify } from "node:crypto";
import { GRANT_TYPES, grantAllowed } from "./dataverse-settings.mjs";

const DATAVERSE_APP_ID = "00000007-0000-0000-c000-000000000000";
const CLIENT_CREDENTIALS = "client_credentials";
const AUTH_CODE = "authorization_code";
const DEVICE_GRANT = GRANT_TYPES.device_code;
const JWT_BEARER = GRANT_TYPES.on_behalf_of;
const SUPPORTED_GRANTS = Object.values(GRANT_TYPES);
const ASSERTION_ALGS = ["RS256", "PS256"];
const FEDERATED_ALG = "RS256"; // Entra workload identity federation documents RS256 only
const NON_INTERACTIVE = 4; // systemuser accessmode NonInteractive
// Live Entra responses omit error_uri for these codes.
const NO_ERROR_URI = new Set([70003, 7000014, 50059]);
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const SKEW_SECONDS = 300;
const REFRESH_LIFETIME_MS = 24 * 60 * 60 * 1000;
const CODE_LIFETIME_MS = 10 * 60 * 1000;
const DEVICE_LIFETIME_SECONDS = 900;
const DEVICE_INTERVAL_SECONDS = 5;
// Grants a public client may redeem without a secret. client_credentials and on_behalf_of are confidential-client flows (AADSTS7000218).
const PUBLIC_GRANTS = new Set([AUTH_CODE, DEVICE_GRANT, GRANT_TYPES.refresh_token, GRANT_TYPES.password]);
const OIDC_SCOPES = new Set(["openid", "profile", "offline_access"]);
const TOKEN_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", pragma: "no-cache" };
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
const AUTHORIZE_FIELDS = ["client_id", "redirect_uri", "scope", "state", "nonce", "response_type", "response_mode", "code_challenge", "code_challenge_method", "prompt", "login_hint"];
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols: no I, O, 0 or 1
const LOOPBACK_REDIRECT = /^http:\/\/localhost(:\d+)?(\/|$)/i;
const NATIVE_CLIENT_REDIRECT = "https://login.microsoftonline.com/common/oauth2/nativeclient";
const MALFORMED = "Invalid request. Request is malformed or invalid.";
const INVALID_SCOPE = "The provided value for the input parameter 'scope' isn't valid. The scope must name exactly one resource (the organization URL with /user_impersonation or /.default).";
const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
// AADSTS code -> [error, HTTP status]. Every code answers 400 except a wrong client secret (401).
const AAD_ERRORS = {
  50011: ["invalid_request", 400],
  50013: ["invalid_grant", 400],
  50034: ["invalid_grant", 400],
  50126: ["invalid_grant", 400],
  50059: ["invalid_request", 400],
  54005: ["invalid_grant", 400],
  65001: ["invalid_grant", 400],
  70008: ["invalid_grant", 400],
  70003: ["unsupported_grant_type", 400],
  70011: ["invalid_scope", 400],
  70016: ["authorization_pending", 400],
  70019: ["expired_token", 400],
  70021: ["invalid_client", 400],
  700016: ["unauthorized_client", 400],
  700027: ["invalid_client", 400],
  700082: ["invalid_grant", 400],
  7000014: ["bad_verification_code", 400],
  7000215: ["invalid_client", 401],
  7000218: ["invalid_client", 400],
  7000222: ["invalid_client", 400],
  90002: ["invalid_request", 400],
  9001023: ["invalid_request", 400],
  500011: ["invalid_resource", 400],
  900144: ["invalid_request", 400],
  9002313: ["invalid_grant", 400],
  9002325: ["invalid_request", 400],
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
// Fixed work factors: serialized credential data cannot choose its own CPU/memory cost.
const SECRET_HASH_PREFIX = "scrypt$";
const secretDigest = (salt, secret) => scryptSync(String(secret), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
// Read-only compatibility for pre-scrypt credentials. New hashes always use scrypt; no legacy writes.
const legacySecretDigest = (salt, secret) => createHash("sha256").update(salt).update(String(secret)).digest();
// RS256 is PKCS#1 v1.5; PS256 is RSASSA-PSS with a 32-byte salt.
const verifies = (data, signature, key, alg = "RS256") => {
  try {
    const options = alg === "PS256" ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : key;
    return verify("sha256", Buffer.from(data), options, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
};
// Both thumbprints (upper-case hex) of a registered credential. For an X.509 certificate PEM they are the
// certificate's SHA-1 and SHA-256 fingerprints, which is what MSAL puts in x5t and x5t#S256; for a bare
// public key PEM (no certificate exists) they are digests of its DER SPKI bytes.
export function certificateThumbprints(pem) {
  if (/-----BEGIN CERTIFICATE-----/.test(String(pem))) {
    const certificate = new X509Certificate(pem);
    return { thumbprint: certificate.fingerprint.replaceAll(":", ""), thumbprint256: certificate.fingerprint256.replaceAll(":", "") };
  }
  const der = createPublicKey(pem).export({ type: "spki", format: "der" });
  return {
    thumbprint: createHash("sha1").update(der).digest("hex").toUpperCase(),
    thumbprint256: createHash("sha256").update(der).digest("hex").toUpperCase(),
  };
}
// Matches a registered certificate by header x5t (SHA-1) or x5t#S256 (SHA-256); thumbprints absent from a record are derived.
const certificateMatches = (cert, header) => {
  const hexOf = (value) => Buffer.from(String(value), "base64url").toString("hex").toUpperCase();
  const x5t = header.x5t ? hexOf(header.x5t) : null;
  const x5tS256 = header["x5t#S256"] ? hexOf(header["x5t#S256"]) : null;
  if (!x5t && !x5tS256) return false;
  const stored = cert.thumbprint && cert.thumbprint256 ? cert : certificateThumbprints(cert.publicKeyPem);
  return (x5t !== null && stored.thumbprint.toUpperCase() === x5t) || (x5tS256 !== null && stored.thumbprint256.toUpperCase() === x5tS256);
};
// Numeric dates as JSON numbers or numeric strings (MSAL.NET serialises nbf and exp as strings).
const numeric = (value) => (typeof value === "number" || (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) ? Number(value) : NaN);
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
// A registered application's own API resource (its app id or api://<appId>), for tokens it exposes to its clients.
const apiResource = (value, apps) => apps.some((app) => [app.appId, `api://${app.appId}`].some((id) => id.toLowerCase() === String(value).toLowerCase()));
const acceptedResource = (value, origin, apps = []) => [origin, `${origin}/`].includes(value) || String(value).toLowerCase() === DATAVERSE_APP_ID || apiResource(value, apps);
// The one resource named by a scope string (OIDC scopes ignored); null when empty, mixed, or not accepted.
// An API resource of a registered application takes any scope name; the Dataverse resource takes .default and user_impersonation.
const scopeResource = (scope, origin, defaultOnly, apps = []) => {
  let resource = null;
  for (const item of String(scope).split(/\s+/).filter(Boolean)) {
    if (OIDC_SCOPES.has(item)) continue;
    const match = /^(.+)\/([^/\s]+)$/.exec(item);
    if (!match) return null;
    const [, name, scopeName] = match;
    const allowed = apiResource(name, apps)
      ? !defaultOnly || scopeName === ".default"
      : acceptedResource(name, origin) && (scopeName === ".default" || (!defaultOnly && scopeName === "user_impersonation"));
    if (!allowed || (resource && resource !== name)) return null;
    resource = name;
  }
  return resource;
};
// Lifetime window shared by bearer tokens and user assertions: exp must be a numeric date not past (with skew), nbf not in the future.
const lifetimeProblem = (claims, nowMs) => {
  const exp = numeric(claims.exp);
  if (!Number.isFinite(exp)) return "malformed";
  if (exp + SKEW_SECONDS < nowMs / 1000) return "expired";
  if (claims.nbf !== undefined && !(numeric(claims.nbf) - SKEW_SECONDS <= nowMs / 1000)) return "not-yet-valid";
  return null;
};
const hasToken = (value, token) => String(value ?? "").split(/\s+/).includes(token);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ENTITIES[ch]);
const htmlPage = (status, title, body) => ({
  status,
  headers: { ...HTML_HEADERS },
  body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><h1>${esc(title)}</h1>${body}</body></html>`,
});
const formPost = (action, fields) =>
  htmlPage(200, "Signing you in", `<form id="f" method="post" action="${esc(action)}">${Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${esc(value)}">`)
    .join("")}<noscript><button type="submit">Continue</button></noscript></form><script>document.getElementById("f").submit();</script>`);
// Query and form fields merged; form (POST body) wins. Accepts a URL, a query object or a string.
const fieldsOf = ({ url, query, form }) => ({ ...Object.fromEntries(new URLSearchParams(query ?? url?.searchParams ?? "")), ...(form ?? {}) });
const normalizeUserCode = (value) => String(value ?? "").replace(/[\s-]/g, "").toUpperCase();
const pkceMatches = (entry, verifier) => {
  if (!verifier) return false;
  const expected = entry.challengeMethod === "S256" ? createHash("sha256").update(String(verifier)).digest("base64url") : String(verifier);
  return expected === entry.challenge;
};
const redirectAllowed = (app, uri) =>
  (app.redirectUris ?? []).includes(uri) || (Boolean(app.publicClient) && (LOOPBACK_REDIRECT.test(String(uri)) || uri === NATIVE_CLIENT_REDIRECT));

export function hashSecret(secret, salt = randomBytes(16)) {
  return { hash: `${SECRET_HASH_PREFIX}${secretDigest(salt, secret).toString("base64url")}`, salt: salt.toString("base64url") };
}

export function verifySecret(secret, { hash, salt } = {}) {
  if (typeof hash !== "string" || typeof salt !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(salt)) return false;
  const modern = hash.startsWith(SECRET_HASH_PREFIX);
  const encoded = modern ? hash.slice(SECRET_HASH_PREFIX.length) : hash;
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return false;
  const expected = Buffer.from(encoded, "base64url");
  const saltBytes = Buffer.from(salt, "base64url");
  const actual = modern ? secretDigest(saltBytes, secret) : legacySecretDigest(saltBytes, secret);
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
      ...(origin && !NO_ERROR_URI.has(code) ? { error_uri: `${origin}/error?code=${code}` } : {}),
    },
  };
}

// federatedIssuers() returns [{ issuer, jwks: { keys } }] for verifying federated client assertions.
export function createAuthority({ tenantId, applications, users, federatedIssuers = () => [], clock = () => Date.now(), accessTokenLifetimeSeconds = 3600 }) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const { kty, n, e } = publicKey.export({ format: "jwk" });
  // kid doubles as x5t: base64url of the SHA-1 of the DER SPKI (no X.509 certificate exists for this key).
  const kid = createHash("sha1").update(publicKey.export({ type: "spki", format: "der" })).digest("base64url");
  const refreshTokens = new Map();
  const codes = new Map();
  const devices = new Map();
  // An expired entry stays until the map is full, so a lookup answers it as expired (as Entra does); an insert into a full
  // map drops the expired entries, then evicts the oldest (Map keeps insertion order).
  // ponytail: a flood of unredeemed codes (or client assertions) can evict a slow client's entry, and an evicted live
  // assertion id can be replayed; raise AUTH_STORE_LIMIT or move these to the state store if that happens.
  const AUTH_STORE_LIMIT = 1000;
  const remember = (map, key, entry) => {
    if (map.size >= AUTH_STORE_LIMIT) {
      const now = clock();
      for (const [stored, value] of map) if (value.expiresAt <= now) map.delete(stored);
    }
    while (map.size >= AUTH_STORE_LIMIT) map.delete(map.keys().next().value);
    map.set(key, entry);
  };
  const knownTenant = (segment) => ["common", "organizations", "consumers", tenantId.toLowerCase()].includes(String(segment).toLowerCase());
  const findApp = (clientId) => applications().find((item) => item.appId.toLowerCase() === String(clientId).toLowerCase());
  // Interactive users only: application users, non-interactive, disabled and oid-less rows cannot sign in or be picked.
  const interactive = (row) => (row && !row.applicationid && row.isdisabled !== true && row.accessmode !== NON_INTERACTIVE && row.azureactivedirectoryobjectid ? row : null);
  const interactiveUser = (oid) => interactive(oid ? users.byObjectId(oid) : null);
  const interactiveUsers = () => (users.list?.() ?? []).filter((row) => interactive(row));

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

  const issueIdToken = ({ origin, app, user, nonce, now }) => {
    const iat = Math.floor(now / 1000);
    const oid = user.azureactivedirectoryobjectid;
    return signJwt({
      iss: `${origin}/${tenantId}/v2.0`,
      aud: app.appId,
      iat,
      exp: iat + accessTokenLifetimeSeconds,
      nonce,
      preferred_username: user.domainname,
      name: user.fullname,
      given_name: user.firstname,
      family_name: user.lastname,
      oid,
      sub: oid,
      tid: tenantId,
      ver: "2.0",
    });
  };

  // Managed identity token (IMDS or App Service): app-only, appid = the identity's client id. Null when the resource is not this directory's.
  const issueManagedIdentityToken = ({ origin, clientId, resource, now = clock() }) => {
    if (!acceptedResource(resource, origin)) return null;
    const iat = Math.floor(now / 1000);
    const appId = String(clientId).toLowerCase();
    return {
      access_token: issueAccessToken({ origin, appId, audience: resource, now }),
      expires_on: String(iat + accessTokenLifetimeSeconds),
      expires_in: String(accessTokenLifetimeSeconds - 1),
      not_before: String(iat),
      resource,
      token_type: "Bearer",
      client_id: appId,
    };
  };

  // userOid is null for application-only refresh tokens; those rebuild app tokens.
  const issueRefreshToken = ({ appId, userOid = null, resource, scope, now = clock() }) => {
    const token = randomBytes(36).toString("base64url");
    remember(refreshTokens, token, { appId: appId.toLowerCase(), userOid, resource, scope, expiresAt: now + REFRESH_LIFETIME_MS });
    return token;
  };

  // expires_in is one second short of the token's exp - iat (Entra reports 3599 for a 3600-second token).
  const tokenBody = ({ version, access, now, audience, scope, refresh }) => {
    const iat = Math.floor(now / 1000);
    const refreshField = refresh ? { refresh_token: refresh } : {};
    const expiresIn = accessTokenLifetimeSeconds - 1;
    if (version === "v1.0") {
      return { token_type: "Bearer", expires_in: String(expiresIn), ext_expires_in: String(expiresIn), expires_on: String(iat + accessTokenLifetimeSeconds), not_before: String(iat), resource: audience, access_token: access, ...refreshField };
    }
    return { token_type: "Bearer", ...(scope ? { scope } : {}), expires_in: expiresIn, ext_expires_in: expiresIn, access_token: access, ...refreshField };
  };

  // The one token response shared by every grant that acts for a user (app-only refresh reuses it without a user).
  const delegatedReply = ({ origin, app, user, resource, scope, nonce, appidacr, version, now, reply, form = {} }) => {
    const access = issueAccessToken({ origin, appId: app.appId, audience: resource, user, appidacr, now });
    const refresh = issueRefreshToken({ appId: app.appId, userOid: user?.azureactivedirectoryobjectid ?? null, resource, scope, now });
    const body = tokenBody({ version, access, now, audience: resource, scope, refresh });
    if (user && hasToken(scope, "openid")) body.id_token = issueIdToken({ origin, app, user, nonce, now });
    if (user && String(form.client_info) === "1") body.client_info = b64json({ uid: user.azureactivedirectoryobjectid, utid: tenantId });
    return reply({ status: 200, body });
  };

  // jti values of accepted client assertions, each kept until the assertion's own expiry window closes.
  const seenAssertions = new Map();

  // The issuer's registered RSA key with the header's kid (any key when the header has none); null when unknown.
  const federatedKey = (issuer, kid) => {
    const entry = (federatedIssuers() ?? []).find((item) => item.issuer === issuer);
    const jwk = (entry?.jwks?.keys ?? []).find((key) => kid === undefined || key.kid === kid);
    if (!jwk) return null;
    try {
      return createPublicKey({ key: jwk, format: "jwk" });
    } catch {
      return null;
    }
  };

  const verifyAssertion = (app, form, { origin, tenantSegment, now }) => {
    const reject = (description, code = 700027) => ({ code, description });
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
    if (!header || typeof header !== "object" || !claims || typeof claims !== "object") return reject("The client assertion is not a JSON Web Token.");
    const data = `${head}.${body}`;
    const audiences = [claims.aud].flat();
    const cert = (app.certificates ?? []).find((item) => certificateMatches(item, header));
    // A federated credential matches the assertion's issuer, subject and audience; no certificate may match first.
    const federated = cert ? null : (app.federatedCredentials ?? []).find((item) => item.issuer === claims.iss && item.subject === claims.sub && audiences.some((aud) => item.audiences.includes(aud)));
    if (cert) {
      if (!ASSERTION_ALGS.includes(header.alg) || !verifies(data, signature, cert.publicKeyPem, header.alg)) return reject("The client assertion signature is invalid.");
      const subject = app.appId.toLowerCase();
      if (String(claims.iss).toLowerCase() !== subject || String(claims.sub).toLowerCase() !== subject) return reject("The client assertion's iss and sub must be the client_id.");
      const endpoints = [tenantSegment, tenantId].flatMap((segment) => [`${origin}/${segment}/oauth2/v2.0/token`, `${origin}/${segment}/oauth2/token`]);
      if (!audiences.some((item) => endpoints.includes(item))) return reject("The client assertion's audience is not this token endpoint.");
    } else if (federated) {
      if (header.alg !== FEDERATED_ALG || !verifies(data, signature, federatedKey(claims.iss, header.kid), FEDERATED_ALG)) return reject("The client assertion signature is invalid.");
    } else if ((app.federatedCredentials ?? []).length) {
      return reject("No matching federated identity record found for presented assertion.", 70021);
    } else {
      return reject("The client assertion is not signed with a registered certificate.");
    }
    const nowSeconds = now / 1000;
    const exp = numeric(claims.exp);
    const nbf = claims.nbf === undefined ? 0 : numeric(claims.nbf);
    if (!Number.isFinite(exp) || Number.isNaN(nbf)) return reject("The client assertion's nbf and exp must be numeric dates.");
    if (nbf > nowSeconds + SKEW_SECONDS) return reject("The client assertion is not yet valid.");
    // Certificate assertions live at most 10 minutes. The cap tolerates clock skew too: msal-node rounds its issue time to the nearest second, so its exp can sit past now + 600.
    // Federated tokens are bounded only by their own exp, since issuers such as cloud identity providers mint hour-long tokens.
    const lifetime = cert ? 600 : Infinity;
    if (exp <= nowSeconds - SKEW_SECONDS || exp > nowSeconds + lifetime + SKEW_SECONDS) return reject(cert ? "The client assertion has expired or lasts longer than 10 minutes." : "The client assertion has expired.");
    // Entra requires a jti on every client assertion (AADSTS700027 without one), so the replay check always applies.
    if (claims.jti === undefined) return reject("The client assertion must contain a jti claim.");
    // Keyed with the issuer, so one issuer's jti cannot collide with another's.
    const id = `${String(claims.iss).toLowerCase()} ${claims.jti}`;
    if (seenAssertions.get(id)?.expiresAt > now) return reject("Assertion replay detected.", 9002313);
    remember(seenAssertions, id, { expiresAt: (exp + SKEW_SECONDS) * 1000 });
    return { appidacr: "2" };
  };

  // Returns { appidacr } on success or { code, description } on failure.
  const authenticateClient = (app, form, basic, ctx) => {
    if (form.client_assertion || form.client_assertion_type) return verifyAssertion(app, form, ctx);
    const secret = form.client_secret ?? basic?.secret;
    if (secret === undefined) {
      if (app.publicClient && PUBLIC_GRANTS.has(form.grant_type)) return { appidacr: "0" };
      return { code: 7000218, description: "The request body must contain the following parameter: 'client_secret' or 'client_assertion'." };
    }
    const match = (app.secrets ?? []).find((item) => verifySecret(secret, item));
    if (!match) return { code: 7000215, description: `Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID, for a secret added to app '${app.appId}'.` };
    if (secretExpiry(match.expiresOn) <= ctx.now) return { code: 7000222, description: "The provided client secret keys are expired. Visit the Azure portal to create new keys for your app." };
    return { appidacr: "1" };
  };

  const userPicker = (hint) => {
    const rows = interactiveUsers();
    if (!rows.length) return '<p><label>User object id <input name="oid" required></label></p>';
    return rows
      .map((row) => {
        const checked = hint && String(row.domainname).toLowerCase() === String(hint).toLowerCase() ? " checked" : "";
        return `<p><label><input type="radio" name="oid" value="${esc(row.azureactivedirectoryobjectid)}" required${checked}> ${esc(row.fullname)} (${esc(row.domainname)})</label></p>`;
      })
      .join("");
  };
  const errorPage = (origin, now, code, description) => htmlPage(400, "Sign-in error", esc(aadError(code, { description, origin, now }).body.error_description));

  // Shared by GET and POST of /authorize: the client, redirect_uri, response_type and scope must all check out.
  const checkAuthorize = (origin, now, input) => {
    const app = findApp(input.client_id);
    if (!app) return { page: errorPage(origin, now, 700016, `Application with identifier '${input.client_id}' was not found in the directory '${tenantId}'.`) };
    if (!redirectAllowed(app, input.redirect_uri)) return { page: errorPage(origin, now, 50011, `The reply URL specified in the request does not match the reply URLs configured for the application: '${app.appId}'.`) };
    if (!hasToken(input.response_type, "code")) return { page: htmlPage(400, "Sign-in error", "unsupported_response_type: response_type must include code.") };
    if (input.code_challenge_method !== undefined && !["S256", "plain"].includes(input.code_challenge_method)) return { page: htmlPage(400, "Sign-in error", "invalid_request: code_challenge_method must be S256 or plain.") };
    if (!scopeResource(input.scope, origin, false, applications())) return { page: errorPage(origin, now, 70011, INVALID_SCOPE) };
    if (app.publicClient && !input.code_challenge) return { page: errorPage(origin, now, 9002325, "Proof Key for Code Exchange is required for cross-origin authorization code redemption.") };
    return { app };
  };

  const handleAuthorize = ({ origin, tenantSegment, url, query, form = {}, method = "GET" }) => {
    const now = clock();
    if (!knownTenant(tenantSegment)) return errorPage(origin, now, 90002, `Tenant '${tenantSegment}' not found. Check to make sure you have the correct tenant ID and are signing into the correct cloud.`);
    const input = fieldsOf({ url, query, form });
    const checked = checkAuthorize(origin, now, input);
    if (checked.page) return checked.page;
    if (String(method).toUpperCase() !== "POST") {
      const hidden = AUTHORIZE_FIELDS.filter((name) => input[name] !== undefined)
        .map((name) => `<input type="hidden" name="${name}" value="${esc(input[name])}">`)
        .join("");
      return htmlPage(200, "Pick an account", `<form method="post">${hidden}${userPicker(input.login_hint)}<button type="submit">Continue</button></form>`);
    }
    const user = interactiveUser(input.oid);
    if (!user) return errorPage(origin, now, 50034, `The user with object id '${input.oid}' was not found in the directory '${tenantId}'.`);
    const code = randomBytes(32).toString("base64url");
    remember(codes, code, {
      clientId: checked.app.appId.toLowerCase(),
      redirectUri: input.redirect_uri,
      scope: input.scope,
      oid: user.azureactivedirectoryobjectid,
      nonce: input.nonce,
      challenge: input.code_challenge,
      challengeMethod: input.code_challenge_method ?? "plain",
      expiresAt: now + CODE_LIFETIME_MS,
      used: false,
    });
    const fields = { code, state: input.state, session_state: randomUUID() };
    if (input.response_mode === "form_post") return formPost(input.redirect_uri, fields);
    const target = new URL(input.redirect_uri);
    for (const [name, value] of Object.entries(fields)) if (value !== undefined) target.searchParams.set(name, value);
    return { status: 302, body: "", headers: { location: target.href, "cache-control": "no-store" } };
  };

  const handleDeviceCode = ({ origin, tenantSegment, form = {} }) => {
    const now = clock();
    const json = (result) => ({ ...result, headers: { ...TOKEN_HEADERS } });
    const fail = (code, description) => json(aadError(code, { description, origin, now }));
    if (!knownTenant(tenantSegment)) return fail(90002, `Tenant '${tenantSegment}' not found. Check to make sure you have the correct tenant ID and are signing into the correct cloud.`);
    if (!form.client_id) return fail(900144, "The request body must contain the following parameter: 'client_id'.");
    const app = findApp(form.client_id);
    if (!app) return fail(700016, `Application with identifier '${form.client_id}' was not found in the directory '${tenantId}'.`);
    if (!grantAllowed(app, DEVICE_GRANT)) return fail(700016, `The client is not permitted to use the grant type '${DEVICE_GRANT}'.`);
    if (!scopeResource(form.scope, origin, false, applications())) return fail(70011, INVALID_SCOPE);
    const userCode = Array.from(randomBytes(9), (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]).join("");
    const deviceCode = randomBytes(36).toString("base64url");
    remember(devices, deviceCode, { clientId: app.appId.toLowerCase(), scope: form.scope, userCode, expiresAt: now + DEVICE_LIFETIME_SECONDS * 1000, lastPoll: null, oid: null });
    const verificationUri = `${origin}/common/oauth2/deviceauth`;
    return json({
      status: 200,
      body: {
        user_code: userCode,
        device_code: deviceCode,
        verification_uri: verificationUri,
        expires_in: DEVICE_LIFETIME_SECONDS,
        interval: DEVICE_INTERVAL_SECONDS,
        message: `To sign in, use a web browser to open the page ${verificationUri} and enter the code ${userCode} to authenticate.`,
      },
    });
  };

  // /common/oauth2/deviceauth: the user types the code and picks an account; POST approves the pending device code.
  const handleDeviceVerification = ({ origin, url, query, form = {}, method = "GET" }) => {
    const now = clock();
    const input = fieldsOf({ url, query, form });
    if (String(method).toUpperCase() !== "POST") {
      return htmlPage(200, "Enter code", `<form method="post"><p><label>Code <input name="otc" value="${esc(input.otc ?? "")}" required></label></p>${userPicker()}<button type="submit">Continue</button></form>`);
    }
    const userCode = normalizeUserCode(input.otc);
    const entry = [...devices.values()].find((item) => item.userCode === userCode);
    if (!entry || entry.expiresAt <= now) return htmlPage(400, "Code not recognised", "<p>The code is unknown or has expired. Start the sign-in again.</p>");
    const user = interactiveUser(input.oid);
    if (!user) return htmlPage(400, "Account not found", "<p>Choose an account that can sign in interactively.</p>");
    entry.oid = user.azureactivedirectoryobjectid;
    return htmlPage(200, "Device connected", "<p>You can close this window and return to the application.</p>");
  };

  const refreshGrant = ({ app, auth, form, origin, version, now, reply, failure }) => {
    if (!form.refresh_token) return failure(900144, "The request body must contain the following parameter: 'refresh_token'.");
    const entry = refreshTokens.get(form.refresh_token);
    if (!entry || entry.appId !== app.appId.toLowerCase()) return failure(9002313, MALFORMED);
    refreshTokens.delete(form.refresh_token);
    // unverified: AADSTS700082 for an expired refresh token follows the Entra error code list; no captured response.
    if (entry.expiresAt <= now) return failure(700082, "The refresh token has expired due to inactivity.");
    const user = entry.userOid ? interactiveUser(entry.userOid) : null;
    if (entry.userOid && !user) return failure(9002313, MALFORMED);
    return delegatedReply({ origin, app, user, resource: entry.resource, scope: entry.scope, appidacr: auth.appidacr, version, now, reply, form });
  };

  const redeemCode = ({ origin, app, auth, form, version, now, reply, failure }) => {
    if (!form.code) return failure(900144, "The request body must contain the following parameter: 'code'.");
    const entry = codes.get(form.code);
    if (!entry || entry.clientId !== app.appId.toLowerCase()) return failure(9002313, MALFORMED);
    if (entry.used) return failure(54005, "The provided authorization code or refresh token has already been redeemed. Authorization codes are single use.");
    entry.used = true; // any redemption attempt spends the code, so a wrong verifier or redirect_uri cannot be retried
    if (entry.expiresAt <= now) return failure(70008, "The provided authorization code or refresh token is expired. Please re-authenticate.");
    if (form.redirect_uri !== entry.redirectUri) return failure(9002313, MALFORMED);
    if (entry.challenge && !pkceMatches(entry, form.code_verifier)) return failure(9002313, "The code_verifier does not match the code_challenge supplied in the authorization request.");
    const user = interactiveUser(entry.oid);
    if (!user) return failure(9002313, MALFORMED);
    return delegatedReply({ origin, app, user, resource: scopeResource(entry.scope, origin, false, applications()), scope: entry.scope, nonce: entry.nonce, appidacr: auth.appidacr, version, now, reply, form });
  };

  const redeemDevice = ({ origin, app, auth, form, version, now, reply, failure }) => {
    if (!form.device_code) return failure(900144, "The request body must contain the following parameter: 'device_code'.");
    const entry = devices.get(form.device_code);
    if (!entry || entry.clientId !== app.appId.toLowerCase()) return failure(7000014, "The provided value for the input parameter 'device_code' is not valid.");
    if (entry.expiresAt <= now) {
      devices.delete(form.device_code);
      return failure(70019, "Verification code expired. Have the user retry the sign-in.");
    }
    const hurried = entry.lastPoll !== null && now - entry.lastPoll < DEVICE_INTERVAL_SECONDS * 1000;
    entry.lastPoll = now;
    if (hurried) {
      const slow = aadError(70016, { description: "Polling too frequently. Wait for the interval before polling again.", origin, now });
      slow.body.error = "slow_down";
      return reply(slow);
    }
    if (!entry.oid) return failure(70016, "OAuth 2.0 device flow error. Authorization is pending. Continue polling.");
    devices.delete(form.device_code);
    const user = interactiveUser(entry.oid);
    if (!user) return failure(9002313, MALFORMED);
    return delegatedReply({ origin, app, user, resource: scopeResource(entry.scope, origin, false, applications()), scope: entry.scope, appidacr: auth.appidacr, version, now, reply, form });
  };

  const passwordGrant = ({ origin, app, auth, form, version, now, reply, failure }) => {
    if (form.username === undefined) return failure(900144, "The request body must contain the following parameter: 'username'.");
    if (form.password === undefined) return failure(900144, "The request body must contain the following parameter: 'password'.");
    const resource = scopeResource(form.scope, origin, false, applications());
    if (!resource) return failure(70011, INVALID_SCOPE);
    const user = interactive(users.byDomainName(form.username));
    if (!user) return failure(50034, `The user account '${form.username}' does not exist in the directory '${tenantId}'.`);
    if (users.verifyPassword?.(user, form.password) !== true) return failure(50126, "Error validating credentials due to invalid username or password.");
    return delegatedReply({ origin, app, user, resource, scope: form.scope, appidacr: auth.appidacr, version, now, reply, form });
  };

  // Returns { user } or { code, description } for an assertion that is not a user token signed by this authority for this client.
  const userFromAssertion = (assertion, now, app) => {
    const reject = (description, code = 9002313) => ({ code, description });
    const [head, body, signature] = String(assertion).split(".");
    let header;
    let claims;
    try {
      header = fromB64json(head);
      claims = fromB64json(body);
    } catch {
      return reject("The assertion is not a JSON Web Token.");
    }
    if (header.alg !== "RS256" || !verifies(`${head}.${body}`, signature, publicKey)) return reject("Assertion failed signature validation.");
    const problem = lifetimeProblem(claims, now);
    if (problem) return reject({ malformed: "The assertion's exp must be a numeric date.", expired: "The assertion has expired.", "not-yet-valid": "The assertion is not yet valid." }[problem]);
    if (claims.idtyp !== "user") return reject("The assertion must be a user token.");
    const user = interactiveUser(claims.oid);
    if (!user) return reject("The assertion's user is not an interactive user in this directory.");
    // Entra answers AADSTS50013 when the assertion's audience is not the presenting app (its app id or api:// URI) or the tenant differs.
    const ownIds = [app.appId, `api://${app.appId}`].map((id) => id.toLowerCase());
    if (!ownIds.some((id) => [claims.aud].flat().some((item) => String(item).toLowerCase() === id)) || claims.tid !== tenantId) {
      return reject("Assertion audience does not match the Client app presenting the assertion.", 50013);
    }
    return { user };
  };

  const onBehalfOf = ({ origin, app, auth, form, version, now, reply, failure }) => {
    if (!form.assertion) return failure(900144, "The request body must contain the following parameter: 'assertion'.");
    const verdict = userFromAssertion(form.assertion, now, app);
    if (!verdict.user) return failure(verdict.code, verdict.description);
    const resource = scopeResource(form.scope, origin, false, applications());
    if (!resource) return failure(70011, INVALID_SCOPE);
    return delegatedReply({ origin, app, user: verdict.user, resource, scope: form.scope, appidacr: auth.appidacr, version, now, reply, form });
  };

  const handleToken = ({ origin, tenantSegment, form = {}, headers = {}, version = "v2.0" }) => {
    const now = clock();
    const reply = (result) => ({ ...result, headers: { ...TOKEN_HEADERS } });
    const failure = (code, description) => reply(aadError(code, { description, origin, now }));
    if (!knownTenant(tenantSegment)) return failure(90002, `Tenant '${tenantSegment}' not found. Check to make sure you have the correct tenant ID and are signing into the correct cloud.`);
    if (!form.grant_type) return failure(900144, "The request body must contain the following parameter: 'grant_type'.");
    if (!SUPPORTED_GRANTS.includes(form.grant_type)) return failure(70003, `The app requested an unsupported grant type '${form.grant_type}'.`);
    if (form.grant_type === GRANT_TYPES.password && ["common", "consumers"].includes(String(tenantSegment).toLowerCase())) return failure(9001023, "The grant type isn't supported on the /common or /consumers authentication contexts. Use /organizations or a tenant ID instead.");
    const basic = parseBasic(headers.authorization);
    const clientId = form.client_id ?? basic?.clientId;
    if (!clientId) return failure(900144, "The request body must contain the following parameter: 'client_id'.");
    const app = findApp(clientId);
    if (!app) {
      // An unregistered client on the on-behalf-of grant is reported as no consent (AADSTS65001), per the milestone 2 contract.
      if (form.grant_type === JWT_BEARER) return failure(65001, `The user or administrator has not consented to use the application with ID '${clientId}'. Send an interactive authorization request for this user and resource.`);
      return failure(700016, `Application with identifier '${clientId}' was not found in the directory '${tenantId}'. This can happen if the application has not been installed by the administrator of the tenant or consented to by any user in the tenant. You may have sent your authentication request to the wrong tenant.`);
    }
    if (!grantAllowed(app, form.grant_type)) return failure(700016, `The client is not permitted to use the grant type '${form.grant_type}'.`);
    const auth = authenticateClient(app, form, basic, { origin, tenantSegment, now });
    if (auth.code) return failure(auth.code, auth.description);

    const grant = { refresh_token: refreshGrant, [AUTH_CODE]: redeemCode, [DEVICE_GRANT]: redeemDevice, password: passwordGrant, [JWT_BEARER]: onBehalfOf }[form.grant_type];
    if (grant) return grant({ origin, app, auth, form, version, now, reply, failure });

    let resource;
    if (version === "v1.0") {
      if (!form.resource) return failure(900144, "The request body must contain the following parameter: 'resource'.");
      if (!acceptedResource(form.resource, origin, applications())) return failure(500011, `The resource '${form.resource}' was not found in the directory '${tenantId}'.`);
      resource = form.resource;
    } else {
      if (!form.scope) return failure(900144, "The request body must contain the following parameter: 'scope'.");
      resource = scopeResource(form.scope, origin, true, applications());
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
    const problem = lifetimeProblem(claims, clock());
    if (problem) return { ok: false, reason: problem };
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
    issueManagedIdentityToken,
  };
}
