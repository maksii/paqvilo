import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';

/*
 * OAuth 2.0 implicit grant endpoints of the portal:
 * POST /_services/auth/token issues an ID token (RS256 JWT) for the signed-in contact and
 * GET /_services/auth/publickey returns the key that validates it. Contract: optional client_id
 * (registered in ImplicitGrantFlow/RegisteredClientId, added as aud and appid), state
 * (returned as a response header), nonce (claim) and response_type=token; expires_in
 * header; validity ImplicitGrantFlow/TokenExpirationTime seconds (default 900, 60..3600);
 * Connector/ImplicitGrantFlowEnabled=False turns the flow off; errors are JSON documents
 * with ErrorId, ErrorMessage, Timestamp and CorrelationId. The local key pair is generated
 * per server process (the platform signs with its site or custom certificate).
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

/** Sign a compact RS256 JWT with the local site key. */
function signIdToken(claims) {
  const header = base64Url(JSON.stringify({ typ: 'JWT', alg: 'RS256' }));
  const payload = base64Url(JSON.stringify(claims));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(siteKeys().privateKey, 'base64url');
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
  return false;
}

/**
 * Handle /_services/auth/token and /_services/auth/publickey. `contact` is the signed-in
 * contact row (or null), `origin` the site origin used as the issuer.
 */
export async function handleImplicitGrant(
  req,
  res,
  url,
  { portal, identity, contact, origin, clock = () => Date.now() },
) {
  const route = /^\/_services\/auth\/(token|publickey)\/?$/i.exec(url.pathname)?.[1]?.toLowerCase();
  if (!route) return false;
  if (!enabled(portal)) return false;
  if (route === 'publickey') {
    if (!['GET', 'HEAD'].includes(req.method)) return false;
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : siteKeys().publicKeyPem);
    return true;
  }
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
  const now = Math.floor(clock() / 1000);
  const lifetime = tokenLifetime(portal);
  const field = (name) => contact?.[name] ?? identity?.[name] ?? '';
  const claims = {
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
  const headers = {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    expires_in: String(lifetime),
  };
  if (params.state) headers.state = params.state;
  res.writeHead(200, headers);
  res.end(signIdToken(claims));
  return true;
}
