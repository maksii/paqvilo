import { createPrivateKey, createPublicKey, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { normalizeThumbprint } from './implicit-grant-settings.mjs';

/*
 * OAuth 2.0 implicit grant endpoints of the portal:
 * POST /_services/auth/token issues an ID token (RS256 JWT) for the signed-in contact and
 * GET /_services/auth/publickey returns the key that validates it. Contract: optional client_id
 * (registered in ImplicitGrantFlow/RegisteredClientId, added as aud and appid), state
 * (returned as a response header), nonce (claim) and response_type=token; expires_in
 * header; validity ImplicitGrantFlow/TokenExpirationTime seconds (default 900, 60..3600);
 * Connector/ImplicitGrantFlowEnabled=False turns the flow off; errors are JSON documents
 * with ErrorId, ErrorMessage, Timestamp and CorrelationId. client_id is at most 36 letters,
 * digits and hyphens; state and nonce are at most 20 characters each
 * (https://learn.microsoft.com/power-pages/security/oauth-implicit-grant-flow#token-endpoint-details).
 * The platform signs with its site certificate, or with the uploaded custom certificate that
 * CustomCertificates/ImplicitGrantflow names by thumbprint. Locally, the implicitGrant.signingKeys setting
 * (implicit-grant-settings.mjs) supplies stable private key files; without one, the key pair is generated per process.
 */
// Generated on first use: a 2048-bit key pair blocks the event loop, and most processes never sign.
let siteKey;
const siteKeys = () => {
  if (!siteKey) {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    siteKey = { privateKey, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) };
  }
  return siteKey;
};

const base64Url = (value) => Buffer.from(value).toString('base64url');
const setting = (portal, name) =>
  Object.entries(portal?.settings ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
const enabled = (portal) =>
  !/^false$/i.test(String(setting(portal, 'Connector/ImplicitGrantFlowEnabled') ?? 'true').trim());

function tokenLifetime(portal) {
  const value = String(setting(portal, 'ImplicitGrantFlow/TokenExpirationTime') ?? '').trim();
  if (!/^\d+$/.test(value)) return 900;
  return Math.min(Math.max(Number(value), 60), 3600);
}

// Custom certificates hold an RSA private key of at least 2048 bits
// (https://learn.microsoft.com/power-apps/maker/portals/admin/manage-custom-certificates#add-new-certificate).
const MINIMUM_KEY_BITS = 2048;
const keyFileError = (file, reason) =>
  Object.assign(new Error(`The implicit grant signing key file ${file} ${reason}`), {
    code: 'IMPLICIT_GRANT_SIGNING_KEY_INVALID',
    file,
  });

/**
 * Reads a PEM RSA private key file and returns { privateKey, publicKeyPem }. A failure is an
 * IMPLICIT_GRANT_SIGNING_KEY_INVALID error that names the file and the reason, never the file's content.
 */
export function readSigningKey(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw keyFileError(
      file,
      error.code === 'ENOENT' ? 'does not exist.' : `cannot be read (${error.code ?? 'error'}).`,
    );
  }
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----|Proc-Type:\s*4,ENCRYPTED/.test(text))
    throw keyFileError(file, 'is encrypted; supply an unencrypted PEM private key file kept outside the export.');
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: text, format: 'pem' });
  } catch {
    throw keyFileError(file, 'is not a PEM private key (PKCS#8 or PKCS#1).');
  }
  if (privateKey.asymmetricKeyType !== 'rsa') throw keyFileError(file, 'does not hold an RSA key, which RS256 needs.');
  if (privateKey.asymmetricKeyDetails.modulusLength < MINIMUM_KEY_BITS)
    throw keyFileError(file, `holds a key shorter than ${MINIMUM_KEY_BITS} bits.`);
  return { privateKey, publicKeyPem: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) };
}

// Configured keys by file, read again when the file's size or modification time changes.
const configuredKeys = new Map();
function configuredKey(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    configuredKeys.delete(file);
    return readSigningKey(file);
  }
  const stamp = `${stat.size}:${stat.mtimeMs}`;
  const cached = configuredKeys.get(file);
  if (cached?.stamp === stamp) return cached.key;
  const key = readSigningKey(file);
  configuredKeys.set(file, { stamp, key });
  return key;
}

/**
 * The key that signs this site's tokens: the configured key whose thumbprint CustomCertificates/ImplicitGrantflow
 * names, else the configured key without a thumbprint, else the per-process key.
 */
function signingKeyOf(portal, signingKeys) {
  const keys = Array.isArray(signingKeys) ? signingKeys : [];
  const named = normalizeThumbprint(setting(portal, 'CustomCertificates/ImplicitGrantflow'));
  const entry = (named && keys.find((key) => key.thumbprint === named)) ?? keys.find((key) => !key.thumbprint);
  return entry ? configuredKey(entry.privateKeyFile) : siteKeys();
}

/** Sign a compact RS256 JWT with the given private key. */
function signIdToken(claims, privateKey) {
  const header = base64Url(JSON.stringify({ typ: 'JWT', alg: 'RS256' }));
  const payload = base64Url(JSON.stringify(claims));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey, 'base64url');
  return `${header}.${payload}.${signature}`;
}

function tokenError(res, status, errorId, message) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(
    JSON.stringify({
      ErrorId: errorId,
      ErrorMessage: message,
      Timestamp: new Date().toLocaleString('en-US', { timeZone: 'UTC' }),
      CorrelationId: randomUUID(),
    }),
  );
  return true;
}

function respondAnonymous(req, res, url, origin) {
  const location = `${origin}/SignIn?ReturnUrl=${encodeURIComponent(url.pathname + url.search)}`;
  if (/xmlhttprequest/i.test(req.headers['x-requested-with'] ?? '')) {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-responded-json': JSON.stringify({ status: 401, headers: { location } }),
    });
    res.end();
  } else {
    res.writeHead(302, { location, 'cache-control': 'no-store' });
    res.end();
  }
}

function validClient(res, portal, clientId) {
  if (clientId == null || clientId === '') return true;
  const registered = String(setting(portal, 'ImplicitGrantFlow/RegisteredClientId') ?? '')
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean);
  if (/^[A-Za-z0-9-]{1,36}$/.test(clientId) && registered.includes(clientId)) return true;
  tokenError(
    res,
    400,
    'PortalSTS0001',
    'Client Id provided in the request is not a valid client Id registered for this portal. Please check the parameter and try again.',
  );
  return false;
}

// A form body larger than this is refused with 413; the rest of it is read and discarded, never buffered.
const MAX_FORM_BYTES = 64 * 1024;
// The state is echoed as a response header, so only tab and printable ASCII can pass.
const STATE_CHARACTERS = /^[\t\x20-\x7e]*$/;
// Documented maximum lengths of state and nonce, in characters (UTF-16 code units, as .NET counts string length).
const MAX_STATE_LENGTH = 20;
const MAX_NONCE_LENGTH = 20;

async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_FORM_BYTES) chunks.push(chunk);
  }
  return size <= MAX_FORM_BYTES ? Buffer.concat(chunks).toString('utf8') : null;
}

// Returns the query and form values, or null when the form body is over the limit.
async function parameters(req, url) {
  const values = Object.fromEntries(url.searchParams);
  if (req.method === 'POST' && /application\/x-www-form-urlencoded/i.test(req.headers['content-type'] ?? '')) {
    const body = await readForm(req);
    if (body === null) return null;
    Object.assign(values, Object.fromEntries(new URLSearchParams(body)));
  }
  return values;
}

// Answers a request that cannot be served as given and returns true, or returns false. The error ids are Mirage's own, not Microsoft's.
function refuseInput(res, params) {
  if (!params) return tokenError(res, 413, 'PortalSTS0003', 'The request body is too large.');
  if (params.state && !STATE_CHARACTERS.test(params.state))
    return tokenError(res, 400, 'PortalSTS0002', 'The state parameter is not valid.');
  if (params.state && params.state.length > MAX_STATE_LENGTH)
    return tokenError(res, 400, 'PortalSTS0002', `The state parameter must be at most ${MAX_STATE_LENGTH} characters.`);
  if (params.nonce && params.nonce.length > MAX_NONCE_LENGTH)
    return tokenError(res, 400, 'PortalSTS0005', `The nonce parameter must be at most ${MAX_NONCE_LENGTH} characters.`);
  if (params.response_type !== undefined && params.response_type !== 'token')
    return tokenError(res, 400, 'PortalSTS0004', 'The response_type parameter must be token.');
  return false;
}

// The key that signs, or null after answering with Mirage's own error document. A configured key file that cannot be
// used goes to onKeyError with its path and reason; the response names neither.
function requestSigningKey(res, portal, signingKeys, onKeyError) {
  try {
    return signingKeyOf(portal, signingKeys);
  } catch (error) {
    if (error.code !== 'IMPLICIT_GRANT_SIGNING_KEY_INVALID') throw error;
    onKeyError?.({ code: error.code, file: error.file, message: error.message });
    tokenError(res, 500, 'PortalSTS0006', 'The configured implicit grant signing key cannot be used.');
    return null;
  }
}

// The public key of the signing key for GET or HEAD /_services/auth/publickey; another method is not handled.
function handlePublicKey(req, res, portal, signingKeys, onKeyError) {
  if (!['GET', 'HEAD'].includes(req.method)) return false;
  const key = requestSigningKey(res, portal, signingKeys, onKeyError);
  if (!key) return true;
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : key.publicKeyPem);
  return true;
}

// The ID token claims of the signed-in contact, read from the contact row, else the session identity.
function idTokenClaims({ contactId, contact, identity, params, clientId, now, lifetime, origin }) {
  const field = (name) => contact?.[name] ?? identity?.[name] ?? '';
  return {
    sub: contactId,
    preferred_username: field('adx_identity_username') || field('emailaddress1') || field('fullname') || contactId,
    phone_number: field('mobilephone') || field('telephone1') || '',
    given_name: field('firstname'),
    family_name: field('lastname'),
    email: field('emailaddress1'),
    ...(params.nonce ? { nonce: params.nonce } : {}),
    ...(clientId ? { aud: clientId, appid: clientId } : {}),
    iat: now,
    nbf: now,
    exp: now + lifetime,
    iss: new URL(origin).host,
  };
}

/**
 * Handle /_services/auth/token and /_services/auth/publickey. `contact` is the signed-in
 * contact row (or null), `origin` the site origin used as the issuer, `signingKeys` the
 * resolved implicitGrant.signingKeys (paths only) and `onKeyError` a diagnostic sink.
 */
export async function handleImplicitGrant(
  req,
  res,
  url,
  { portal, identity, contact, origin, signingKeys, onKeyError, clock = () => Date.now() },
) {
  const route = /^\/_services\/auth\/(token|publickey)\/?$/i.exec(url.pathname)?.[1]?.toLowerCase();
  if (!route) return false;
  if (!enabled(portal)) return false;
  if (route === 'publickey') return handlePublicKey(req, res, portal, signingKeys, onKeyError);
  if (req.method !== 'POST') return false;
  const contactId = identity?.contactId ?? identity?.id ?? null;
  if (!contactId) {
    // Cookie authentication answers an anonymous AJAX call with 200 and X-Responded-JSON
    // (status 401 and the sign-in location); a navigation is redirected to sign-in.
    respondAnonymous(req, res, url, origin);
    return true;
  }
  const params = await parameters(req, url);
  if (refuseInput(res, params)) return true;
  const clientId = params.client_id;
  if (!validClient(res, portal, clientId)) return true;
  const key = requestSigningKey(res, portal, signingKeys, onKeyError);
  if (!key) return true;
  const now = Math.floor(clock() / 1000);
  const lifetime = tokenLifetime(portal);
  const claims = idTokenClaims({ contactId, contact, identity, params, clientId, now, lifetime, origin });
  const headers = {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    expires_in: String(lifetime),
  };
  if (params.state) headers.state = params.state;
  res.writeHead(200, headers);
  res.end(signIdToken(claims, key.privateKey));
  return true;
}
