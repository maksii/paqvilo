import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * OAuth 1.0a (RFC 5849) for the Twitter provider, as the OWIN Twitter middleware the platform builds on runs it: a
 * request token (POST oauth/request_token with oauth_callback), the user's authorization (oauth/authenticate), and an
 * access token for the oauth_verifier (POST oauth/access_token), every request signed with HMAC-SHA1 in an
 * `Authorization: OAuth` header. Learn ("Set up the Twitter provider") configures the consumer key and secret as the
 * provider's client ID and client secret (Authentication/OpenAuth/Twitter/ConsumerKey and ConsumerSecret).
 *
 * The local identity provider (createOauth1Provider) checks the consumer key, the signature over the request
 * (method, URL, query, form body and oauth_* parameters), a timestamp within five minutes of its clock and a nonce that
 * is used once, the registered callback, and single-use request tokens and verifiers.
 */

const SIGNATURE_METHOD = 'HMAC-SHA1';
const TIMESTAMP_WINDOW_S = 300;
const REQUEST_TOKEN_LIFETIME_MS = 5 * 60 * 1000;
const LIMIT = 1000;

export class Oauth1Problem extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

/** RFC 5849 3.6 percent-encoding: everything but ALPHA, DIGIT, "-", ".", "_" and "~". */
const percentEncode = (value) =>
  encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** The signature base string (RFC 5849 3.4.1) of a request with `parameters` ([name, value] pairs, oauth_signature excluded). */
function signatureBase(method, url, parameters) {
  const target = new URL(url);
  const base = `${target.protocol}//${target.host.toLowerCase()}${target.pathname}`;
  const normalized = parameters
    .map(([name, value]) => [percentEncode(name), percentEncode(value)])
    .sort(([a, x], [b, y]) => (a === b ? compare(x, y) : compare(a, b)))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  return [method.toUpperCase(), percentEncode(base), percentEncode(normalized)].join('&');
}
const compare = (a, b) => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};
const hmac = (base, consumerSecret, tokenSecret = '') =>
  createHmac('sha1', `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`)
    .update(base)
    .digest('base64');

/** The Authorization header of a signed request: `oauth` holds the protocol parameters, `body` the form parameters. */
export function signedAuthorization({
  method,
  url,
  consumerKey,
  consumerSecret,
  token = null,
  tokenSecret = '',
  oauth = {},
  body = {},
  now,
}) {
  const protocol = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: SIGNATURE_METHOD,
    oauth_timestamp: String(Math.floor(now / 1000)),
    oauth_version: '1.0',
    ...(token ? { oauth_token: token } : {}),
    ...oauth,
  };
  const query = [...new URL(url).searchParams];
  const base = signatureBase(method, url, [...Object.entries(protocol), ...query, ...Object.entries(body)]);
  const signature = hmac(base, consumerSecret, tokenSecret);
  return (
    'OAuth ' +
    Object.entries({ ...protocol, oauth_signature: signature })
      .map(([name, value]) => `${percentEncode(name)}="${percentEncode(value)}"`)
      .join(', ')
  );
}

/** The protocol parameters of an `Authorization: OAuth` header (a Map of name to value), or null. */
function parseAuthorization(header) {
  const text = String(header ?? '').trim();
  if (!/^OAuth\s/i.test(text) || text.length > 4096) return null;
  const parameters = new Map();
  for (const part of text.slice(6).split(',')) {
    const item = part.trim();
    if (!item) continue;
    const index = item.indexOf('=');
    if (index < 1) return null;
    const name = item.slice(0, index).trim();
    const quoted = item.slice(index + 1).trim();
    if (quoted.length < 2 || !quoted.startsWith('"') || !quoted.endsWith('"')) return null;
    let value;
    try {
      value = decodeURIComponent(quoted.slice(1, -1));
    } catch {
      return null;
    }
    if (parameters.has(name)) return null;
    parameters.set(name, value);
  }
  return parameters;
}

const token = () => randomBytes(24).toString('base64url');
const remember = (map, key, value) => {
  map.set(key, value);
  if (map.size > LIMIT) map.delete(map.keys().next().value);
};
const equalText = (a, b) => {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * The identity provider side for one runtime: request(provider, req, url, form) verifies a signed request and
 * returns its oauth_* parameters; requestToken, authorize and accessToken issue the protocol's answers.
 */
export function createOauth1Provider({ clock }) {
  const nonces = new Map();
  const requestTokens = new Map();

  /** Verifies the signed request; `tokenSecret` is the secret of its oauth_token (access token requests). */
  function verifyRequest(provider, { method, url, header, body = {} }, tokenSecret = '') {
    const protocol = parseAuthorization(header);
    if (!protocol) throw new Oauth1Problem('The request has no OAuth 1.0a Authorization header.');
    const field = (name) => protocol.get(name);
    if (field('oauth_consumer_key') !== provider.clientId)
      throw new Oauth1Problem('The consumer key is not registered.');
    if (!provider.clientSecret)
      throw new Oauth1Problem('No consumer secret is registered for this consumer: set ConsumerSecret.');
    if (field('oauth_signature_method') !== SIGNATURE_METHOD)
      throw new Oauth1Problem('The signature method is not HMAC-SHA1.', 400);
    if (protocol.has('oauth_version') && field('oauth_version') !== '1.0')
      throw new Oauth1Problem('The OAuth version is not 1.0.', 400);
    const timestamp = Number(field('oauth_timestamp'));
    const now = clock() / 1000;
    if (!/^\d{1,12}$/.test(field('oauth_timestamp') ?? '') || Math.abs(now - timestamp) > TIMESTAMP_WINDOW_S)
      throw new Oauth1Problem('The timestamp is missing or outside the accepted window.');
    if (!/^[\w.~-]{8,128}$/.test(field('oauth_nonce') ?? ''))
      throw new Oauth1Problem('The nonce is missing or malformed.');
    const parameters = [
      ...[...protocol].filter(([name]) => name !== 'oauth_signature' && name !== 'realm'),
      ...new URL(url).searchParams,
      ...Object.entries(body),
    ];
    const expected = hmac(signatureBase(method, url, parameters), provider.clientSecret, tokenSecret);
    if (!equalText(expected, field('oauth_signature'))) throw new Oauth1Problem('The request signature is invalid.');
    for (const [key, until] of nonces) if (until <= now) nonces.delete(key);
    const used = `${provider.slug}|${field('oauth_timestamp')}|${field('oauth_nonce')}`;
    if (nonces.has(used)) throw new Oauth1Problem('The nonce was already used (replay).');
    remember(nonces, used, timestamp + TIMESTAMP_WINDOW_S * 2);
    return protocol;
  }

  /** POST oauth/request_token: a request token for the registered callback. */
  function requestToken(provider, request) {
    const protocol = verifyRequest(provider, request);
    if (protocol.get('oauth_callback') !== provider.redirectUri)
      throw new Oauth1Problem(`The oauth_callback is not the registered callback URL (${provider.redirectUri}).`, 403);
    const value = token();
    const secret = token();
    remember(requestTokens, value, {
      slug: provider.slug,
      secret,
      verifier: null,
      user: null,
      expires: clock() + REQUEST_TOKEN_LIFETIME_MS,
    });
    return { oauth_token: value, oauth_token_secret: secret, oauth_callback_confirmed: 'true' };
  }

  /** A request token the user may authorize (oauth/authenticate), or null. */
  function pendingToken(provider, value) {
    const entry = requestTokens.get(String(value ?? ''));
    return entry && entry.slug === provider.slug && !entry.verifier && clock() <= entry.expires ? entry : null;
  }

  /** The user's authorization: the callback URL with the request token and a verifier. */
  function authorize(provider, value, user) {
    const entry = pendingToken(provider, value);
    if (!entry) throw new Oauth1Problem('The request token is unknown, expired or already authorized.', 400);
    entry.verifier = token();
    entry.user = user;
    const target = new URL(provider.redirectUri);
    target.searchParams.set('oauth_token', value);
    target.searchParams.set('oauth_verifier', entry.verifier);
    return target.href;
  }

  /** POST oauth/access_token: the authorized user for the request token and verifier, once. */
  function accessToken(provider, request) {
    const header = parseAuthorization(request.header);
    const requestToken = header?.get('oauth_token') ?? '';
    const entry = requestTokens.get(requestToken);
    if (!entry || entry.slug !== provider.slug) throw new Oauth1Problem('The request token is unknown.');
    verifyRequest(provider, request, entry.secret);
    requestTokens.delete(requestToken);
    const verifier = request.body.oauth_verifier ?? header.get('oauth_verifier');
    if (!entry.verifier || !equalText(entry.verifier, verifier) || clock() > entry.expires)
      throw new Oauth1Problem('The verifier does not match the authorized request token.');
    return {
      oauth_token: token(),
      oauth_token_secret: token(),
      user_id: entry.user.subject,
      screen_name: entry.user.screenName,
    };
  }

  return { requestToken, pendingToken, authorize, accessToken };
}
