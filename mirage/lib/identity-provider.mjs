import http from 'node:http';
import { keepIdleConnections } from './idle-connections.mjs';
import { createHash, createPublicKey, generateKeyPair, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chooserReport, chooserResults, chooserSearch, CHOOSER_PARAMETERS } from './persona-chooser.mjs';
import { identityProviderSettings, newUserPolicy } from './identity-provider-settings.mjs';
import { recordHttpError } from './trace-store.mjs';
import {
  CLAIM_TYPES,
  FederationProblem,
  identityProviderMetadata,
  inflateMessage,
  logoutResponseXml,
  messageId,
  postMessage,
  readAuthnRequest,
  readLogoutRequest,
  SAML,
  signedAssertion,
  signedRedirectQuery,
  signedResponse,
  verifyRedirectQuery,
  wsFederationResult,
} from './identity-federation.mjs';
import { ANONYMOUS_ROOT, setTraceHeaders } from './trace-hosts.mjs';
import { createOauth1Provider, Oauth1Problem } from './identity-oauth1.mjs';

/**
 * Local identity provider for the portal's external sign-in. Each runtime starts one on its
 * own loopback port, cross-origin to the portal like an online provider. Per configured
 * provider it serves, under the provider's local authority http://<host>:<port>/<slug>/, the
 * endpoints the portal uses for external sign-in: the OpenID Connect discovery document, its
 * signing keys, oauth2/authorize and oauth2/logout; and, for the authorization code flow,
 * oauth2/token (client_secret_post or private_key_jwt, with PKCE) and openid/userinfo.
 *
 * The authorize page lists active local contacts. Its optional "New user" form follows
 * identityProvider.newUser (auto | always | never); auto checks site registration,
 * open-registration/invitation and provider registration settings. prompt=create can
 * expose a forced registration test unless newUser is never. Its answer follows the response type: an RS256 id_token,
 * an authorization code and an access token as requested, posted back with
 * response_mode=form_post or appended to the redirect URI with response_mode=query.
 * prompt=none answers without a page (login_hint or the provider's session) or with
 * login_required; prompt=login, select_account, consent and create always show the page.
 * acr_values come back as the id_token's acr claim. Its pages are plainly a local simulation
 * and never imitate an online provider's sign-in screen.
 *
 * OAuth 2.0 providers (type oauth2) use the same authorize page with response_type code only and no OpenID Connect
 * parameters; their token endpoint answers an access token without id_token, which reads openid/userinfo as the
 * provider's user profile.
 *
 * SAML 2.0 providers (type saml2) serve, under the same local authority, federationmetadata/2007-06/
 * federationmetadata.xml (entityID = the provider's AuthenticationType, its signing key), saml2 (HTTP-Redirect
 * AuthnRequest; the chooser answers a signed Response and signed assertion posted to the registered assertion
 * consumer service URL), saml2/idpinitiated (an unsolicited response, RelayState passed through) and saml2/logout (a
 * LogoutRequest signed with the key registered under the site's ExternalLogoutCertThumbprint, answered with a
 * signed LogoutResponse redirect to the reply URL). WS-Federation providers (type wsfederation) serve the metadata
 * and wsfed: wa=wsignin1.0 for the registered wtrealm and wreply answers a RequestSecurityTokenResponse with a signed
 * SAML 2.0 assertion; wa=wsignout1.0 ends the provider session and follows a wreply on the portal's origin.
 */

const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const base64url = (value) => Buffer.from(value).toString('base64url');
const leftHash = (value) => createHash('sha256').update(value).digest().subarray(0, 16).toString('base64url');
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TITLE = 'Local identity provider (simulation)';
/** Protocol parameters of the authorize request; other parameters are the request's extras. */
const AUTHORIZE_FIELDS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
  'response_mode',
  'nonce',
  'ui_locales',
  'login_hint',
  'prompt',
  'acr_values',
  'code_challenge',
  'code_challenge_method',
];
/** Fields of the chooser's own forms. */
const CHOOSER_FIELDS = new Set([
  'subject',
  'given_name',
  'family_name',
  'email',
  'phone_number',
  ...CHOOSER_PARAMETERS,
]);
/** Response types the provider answers; Power Pages does not support code token. */
const RESPONSE_TYPES = ['code', 'id_token', 'code id_token', 'id_token token', 'code id_token token'];
const PROMPTS = ['none', 'login', 'consent', 'select_account', 'create'];
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const CODE_LIFETIME_MS = 5 * 60 * 1000;
const TOKEN_LIFETIME_S = 3600;
const LIMIT = 500;
/** Provider types served with SAML 2.0 and WS-Federation messages instead of OpenID Connect. */
const FEDERATED = new Set(['saml2', 'wsfederation']);

const normalizeResponseType = (value) =>
  String(value ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort(/* NOSONAR: preserve default string coercion */)
    .join(' ');
const remember = (map, key, value) => {
  map.set(key, value);
  if (map.size > LIMIT) map.delete(map.keys().next().value);
};

function page(body, { autoSubmit = false, head = '' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${TITLE}</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f4f4f4;color:#222}main{max-width:680px;margin:32px auto;padding:20px 24px;background:#fff;border:2px dashed #8a6d3b;border-radius:6px}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:20px 0 4px}.note{color:#8a6d3b;font-size:13px;margin:0 0 12px}ul{list-style:none;padding:0;margin:0}li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-top:1px solid #eee}button{font:inherit;padding:5px 12px;cursor:pointer}label{display:block;margin:6px 0}input[type=text],input[type=email],input[type=tel]{width:100%;padding:5px;box-sizing:border-box}small{color:#666}code{font-size:12px}dl{margin:0;font-size:13px}dt{font-weight:600}dd{margin:0 0 4px}</style>${head}</head><body${autoSubmit ? ' onload="document.forms[0].submit()"' : ''}><main>${body}</main></body></html>`;
}

/** Display, given and family names of a preset user. */
function nameParts(user) {
  const name = String(user.name ?? '').trim();
  const given = String(user.givenName ?? '').trim() || (name.split(/\s+/)[0] ?? '');
  const family = String(user.familyName ?? '').trim() || name.split(/\s+/).slice(1).join(' ');
  return { name: name || [given, family].filter(Boolean).join(' ') || user.email || user.subject, given, family };
}

const normalizeHint = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[{}]/g, '');

/** A compact JWT's header and claims, or null. */
function decodeJwt(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      parts,
      header: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')),
      claims: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')),
    };
  } catch {
    return null;
  }
}

/**
 * Start the identity provider.
 * - providers(): the portal's providers ({ slug, key, caption, clientId, redirectUri,
 *   clientSecret, tokenAuthMethod, clientKeys }): the client registration. clientSecret is
 *   checked for client_secret_post, clientKeys (public JWKs with their kid) for
 *   private_key_jwt client assertions.
 * - users(provider): preset users ({ contactId, subject, name, givenName, familyName, email,
 *   phone, description, hints }).
 * - provision(provider, user): called before a preset user's answer is issued, so the
 *   portal's data records that contact's identity at the provider (async).
 * - allowRedirect(url): whether a post_logout_redirect_uri is on the portal's origin.
 */

/** PKCE (RFC 7636): the code_verifier for the code's challenge; an error message or null. */
function verifyPkce(entry, verifier) {
  if (!entry.challenge) return null;
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(String(verifier ?? '')))
    return 'The code_verifier is missing or malformed (PKCE).';
  const derived = entry.method === 'S256' ? createHash('sha256').update(verifier).digest('base64url') : verifier;
  return derived === entry.challenge ? null : 'The code_verifier does not match the code_challenge (PKCE).';
}
/* NOSONAR: preserve asynchronous lifecycle and concurrent operation ordering */ export async function startIdentityProvider({
  host = '127.0.0.1',
  port = 0,
  providers,
  users,
  personaCatalog = () => null,
  registration = () => ({}),
  settings = {},
  assets = [],
  fullPicker = null,
  provision = async () => {},
  siteAdmission = () => false,
  allowRedirect = () => false,
  clock = () => Date.now(),
  // The runtime's trace store (docs/design/tracing.md): each request is an http root of host identity-provider, joined to
  // the portal's back-channel calls through their forwarded trace headers (D-R3-8).
  traces = null,
  // Generates the signing key pair; the default runs off the event loop. Tests pass their own to hold it.
  generateSigningKeyPair = promisify(generateKeyPair),
  // Counts the chooser's work ({ compared, scanned }, persona-chooser.mjs chooserSelection) when given.
  chooserWork = null,
}) {
  settings = identityProviderSettings(settings);
  const builtinAssets = new Map(
    await Promise.all(
      ['persona-chooser-client.mjs', 'persona-chooser.css'].map(async (name) => [
        '/_idp/' + name,
        await fs.readFile(new URL(name, import.meta.url)),
      ]),
    ),
  );
  // Generated off the event loop by the first request that needs it (most runs never sign in). Concurrent first requests
  // share one generation; a failed generation fails the requests that waited for it, and the next request tries again.
  let pendingKey = null;
  const signingKey = () => {
    pendingKey ??= Promise.resolve()
      .then(() => generateSigningKeyPair('rsa', { modulusLength: 2048 }))
      .then(({ privateKey, publicKey }) => {
        const jwk = publicKey.export({ format: 'jwk' });
        return { privateKey, jwk, kid: createHash('sha256').update(jwk.n).digest('base64url').slice(0, 16) };
      })
      .catch((error) => {
        pendingKey = null;
        throw error;
      });
    return pendingKey;
  };
  let origin = null;
  let cookieName = 'paqvilo-mirage-idp';
  const sessions = new Map();
  const codes = new Map();
  const accessTokens = new Map();
  const assertions = new Map();
  const authority = (provider) => `${origin}/${provider.slug}/`;
  const tokenEndpoint = (provider) => `${authority(provider)}oauth2/token`;
  const signToken = async (payload) => {
    const { privateKey, kid } = await signingKey();
    const header = base64url(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid }));
    const body = base64url(JSON.stringify(payload));
    return `${header}.${body}.${sign('sha256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url')}`; // NOSONAR: preserve template coercion and selected evaluation
  };
  const headers = (extra = {}) => ({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...extra,
  });
  const respond = (res, status, html, extra = {}) => {
    res.writeHead(status, headers(extra));
    res.end(html);
  };
  const json = (res, status, value, extra = {}) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
      ...extra,
    });
    res.end(JSON.stringify(value));
  };
  // The refusal a response names, for the request's http root (D-R3-4).
  const refusals = new WeakMap();
  const fail = (res, status, message) => {
    refusals.set(res, { code: 'IdentityProviderRequestRejected', message });
    return respond(
      res,
      status,
      page(
        `<h1>${TITLE}</h1><p class="note">The request was rejected.</p><p role="alert" id="paqvilo-mirage-idp-error">${escapeHtml(message)}</p>`,
      ),
    );
  };
  /** A token endpoint error (RFC 6749 5.2); invalid_client answers 401. */
  const tokenError = (res, error, description) => {
    refusals.set(res, { code: error, message: description });
    return json(res, error === 'invalid_client' ? 401 : 400, { error, error_description: description });
  };
  const readForm = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 65536) {
          reject(Object.assign(new Error('The request body is too large.'), { status: 413 }));
          req.destroy();
        } else chunks.push(chunk);
      });
      req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))));
      req.on('error', reject);
    });
  const sessionCookie = (req) => {
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const index = part.indexOf('=');
      if (index > 0 && part.slice(0, index).trim() === cookieName) return part.slice(index + 1).trim();
    }
    return null;
  };
  const authorizeParams = (source) =>
    Object.fromEntries(AUTHORIZE_FIELDS.map((key) => [key, String(source[key] ?? '')]));
  /** Non-protocol parameters of the request (custom authorization parameters), bounded. */
  const extrasOf = (source) =>
    Object.fromEntries(
      Object.entries(source)
        .filter(
          ([key, value]) =>
            !AUTHORIZE_FIELDS.includes(key) &&
            !CHOOSER_FIELDS.has(key) &&
            /^[A-Za-z0-9_.-]{1,64}$/.test(key) &&
            typeof value === 'string' &&
            value.length <= 1000,
        )
        .slice(0, 20),
    );
  /** Like an online provider: an unknown client or unregistered reply URL is never redirected to. */
  const registrationProblem = (provider, params) => {
    if (params.client_id !== provider.clientId)
      return `The client_id "${params.client_id}" is not registered for this provider (expected "${provider.clientId}").`;
    if (params.redirect_uri !== provider.redirectUri)
      return `The redirect_uri "${params.redirect_uri}" is not the provider's registered reply URL (${provider.redirectUri}).`;
    return null;
  };
  const promptProblem = (params) => {
    const prompts = params.prompt.split(/\s+/).filter(Boolean);
    if (prompts.some((value) => !PROMPTS.includes(value)))
      return `prompt "${params.prompt}" is not supported (supported: ${PROMPTS.join(', ')}).`;
    if (prompts.includes('none') && prompts.length > 1)
      return 'prompt=none cannot be combined with another prompt value.';
    return null;
  };
  /** OAuth 2.0 (RFC 6749 4.1): the authorization code grant, answered on the redirect URI's query string. */
  const validateOauthAuthorize = (provider, params) => {
    const registration = registrationProblem(provider, params);
    if (registration) return registration;
    if (params.response_type !== 'code') return 'This OAuth 2.0 provider answers response_type code only.';
    if (params.response_mode !== 'query') return 'An OAuth 2.0 authorization code is returned on the query string.';
    if (!params.state) return 'state is required.';
    return promptProblem(params);
  };
  const validateAuthorize = (provider, params) => {
    if (provider.type === 'oauth2') return validateOauthAuthorize(provider, params);
    const registration = registrationProblem(provider, params);
    if (registration) return registration;
    const type = normalizeResponseType(params.response_type);
    if (!RESPONSE_TYPES.map(normalizeResponseType).includes(type))
      return `response_type "${params.response_type}" is not supported (supported: ${RESPONSE_TYPES.join(', ')}).`;
    if (!['form_post', 'query'].includes(params.response_mode)) return 'response_mode must be form_post or query.';
    if (!/(?:^|\s)openid(?:\s|$)/.test(params.scope)) return 'scope must include openid.';
    // A nonce is required wherever the id_token comes from this endpoint (implicit and hybrid).
    if (!params.state || (/\bid_token\b/.test(type) && !params.nonce)) return 'state and nonce are required.';
    const prompt = promptProblem(params);
    if (prompt) return prompt;
    if (params.code_challenge && !/^[A-Za-z0-9._~-]{43,128}$/.test(params.code_challenge))
      return 'code_challenge must be 43 to 128 unreserved characters.';
    if (
      params.code_challenge_method &&
      (!params.code_challenge || !['S256', 'plain'].includes(params.code_challenge_method))
    )
      return 'code_challenge_method must be S256 or plain, with a code_challenge.';
    return null;
  };
  /** Sends `fields` to the redirect URI: an auto-submitting form_post page or a query redirect. */
  const deliver = (res, params, fields, extra = {}) => {
    if (params.response_mode === 'query') {
      const target = new URL(params.redirect_uri);
      for (const [key, value] of Object.entries(fields)) target.searchParams.set(key, value);
      res.writeHead(302, { location: target.href, 'cache-control': 'no-store', ...extra });
      return res.end();
    }
    const inputs = Object.entries(fields)
      .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
      .join('');
    return respond(
      res,
      200,
      page(
        `<form method="post" action="${escapeHtml(params.redirect_uri)}">${inputs}<h1>${TITLE}</h1><p class="note">Returning to the portal…</p><noscript><button type="submit">Continue</button></noscript></form>`,
        { autoSubmit: true },
      ),
      extra,
    );
  };
  /** An authorization error response (OpenID Connect Core 3.1.2.6), such as login_required. */
  const deny = (res, params, error, description) =>
    deliver(res, params, { error, error_description: description, state: params.state });
  /** Claims of `user` in an id_token for `params` (nonce, acr) and the hashes of the codes/tokens it accompanies. */
  const idTokenClaims = (provider, params, user, { code = null, accessToken = null } = {}) => {
    const { name, given, family } = nameParts(user);
    const now = Math.floor(clock() / 1000);
    const acr = params.acr_values.split(/\s+/).find(Boolean);
    return {
      aud: params.client_id,
      iss: authority(provider),
      iat: now,
      nbf: now,
      exp: now + TOKEN_LIFETIME_S,
      ...(acr ? { acr } : {}),
      ...(accessToken ? { at_hash: leftHash(accessToken) } : {}),
      ...(code ? { c_hash: leftHash(code) } : {}),
      ...(user.email ? { email: user.email, preferred_username: user.email } : {}),
      ...(family ? { family_name: family } : {}),
      ...(given ? { given_name: given } : {}),
      name,
      ...(params.nonce ? { nonce: params.nonce } : {}),
      oid: user.subject,
      sub: user.subject,
    };
  };
  /** UserInfo claims (OpenID Connect Core 5.3): the id_token's profile claims and the phone number. */
  const userInfoClaims = (user) => {
    const { name, given, family } = nameParts(user);
    return {
      sub: user.subject,
      name,
      ...(given ? { given_name: given } : {}),
      ...(family ? { family_name: family } : {}),
      ...(user.email ? { email: user.email, email_verified: true, preferred_username: user.email } : {}),
      ...(user.phone ? { phone_number: user.phone } : {}),
    };
  };
  const issueAccessToken = (provider, params, user) => {
    const token = randomBytes(32).toString('base64url');
    remember(accessTokens, token, {
      slug: provider.slug,
      clientId: params.client_id,
      user,
      scope: params.scope,
      expires: clock() + TOKEN_LIFETIME_S * 1000,
    });
    return token;
  };
  /** The authorization response for `user`, as the response type asks. */
  const answer = async (res, provider, params, user) => {
    const type = new Set(normalizeResponseType(params.response_type).split(' '));
    const code = type.has('code') ? randomBytes(24).toString('base64url') : null;
    if (code)
      remember(codes, code, {
        slug: provider.slug,
        clientId: params.client_id,
        redirectUri: params.redirect_uri,
        user,
        nonce: params.nonce,
        scope: params.scope,
        acr: params.acr_values,
        challenge: params.code_challenge || null,
        method: params.code_challenge ? params.code_challenge_method || 'plain' : null,
        expires: clock() + CODE_LIFETIME_MS,
      });
    const accessToken = type.has('token') ? issueAccessToken(provider, params, user) : null;
    const fields = {
      ...(code ? { code } : {}),
      ...(accessToken ? { access_token: accessToken, token_type: 'Bearer', expires_in: String(TOKEN_LIFETIME_S) } : {}),
      ...(type.has('id_token')
        ? { id_token: await signToken(idTokenClaims(provider, params, user, { code, accessToken })) }
        : {}),
      state: params.state,
    };
    return deliver(res, params, fields, startSession(provider, user));
  };
  /** This browser's session at the provider (prompt=none, sign-out); the header that sets its cookie. */
  const startSession = (provider, user, sessionIndex = null) => {
    const session = randomBytes(18).toString('base64url');
    remember(sessions, session, { subject: user.subject, provider: provider.slug, user, sessionIndex, at: clock() });
    return { 'set-cookie': `${cookieName}=${session}; Path=/; HttpOnly; SameSite=Lax` };
  };
  const chooser = (provider, params, extras, list, query, route = 'oauth2/authorize') /* NOSONAR */ => {
    // NOSONAR: preserve state, evaluation order, and lifecycle
    const hidden = Object.entries({ ...extras, ...params })
      .filter(([, value]) => value)
      .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
      .join('');
    const action = `/${provider.slug}/${route}`,
      report = chooserReport(personaCatalog(), list);
    const parameters = new URLSearchParams(query);
    for (const [key, value] of Object.entries({ ...extras, ...params })) if (value) parameters.set(key, value);
    if (parameters.get('view') === 'picker') return chooserResults(report, parameters, action, chooserWork);
    const policy = siteAdmission(params)
        ? { allowed: false }
        : newUserPolicy(settings, registration(), provider, params),
      presentation = parameters.get('presentation') === 'dialog' ? 'dialog' : settings.presentation;
    const requested =
      [
        ...Object.entries(extras),
        ...['prompt', 'acr_values'].filter((key) => params[key]).map((key) => [key, params[key]]),
      ]
        .map(
          ([key, value]) =>
            `<dt>${escapeHtml(key)}</dt><dd class="paqvilo-mirage-idp-extra" data-name="${escapeHtml(key)}"${['prompt', 'acr_values'].includes(key) ? ` id="paqvilo-mirage-idp-${key === 'acr_values' ? 'acr' : 'prompt'}"` : ''}>${escapeHtml(value)}</dd>`, // NOSONAR: preserve lazy branch evaluation and coercion; preserve template coercion and selected evaluation
        )
        .join('') +
      (params.prompt.split(/\s+/).includes('consent')
        ? `<dt>consent</dt><dd>The portal asks for consent to the scope ${escapeHtml(params.scope)}.</dd>`
        : '');
    const create = policy.allowed
      ? `<section class="chooser-registration paqvilo-mirage-idp-new-user" id="paqvilo-mirage-idp-create"><form method="post" action="${action}" id="idp-register">${hidden}</form><h2>New user</h2><p>Create an external identity for the portal’s first-time registration flow.</p>${/* NOSONAR */ policy.forced ? /* NOSONAR */ `<p class="chooser-warning">Forced registration test. The portal disables registration with: ${escapeHtml(policy.disabled.join(', '))}. The portal may reject the callback.</p>` : ''}<div class="chooser-registration-fields">${[
          // NOSONAR: preserve template coercion and selected evaluation; preserve lazy branch evaluation and coercion
          ['given_name', 'Given name', 'text', 100],
          ['family_name', 'Family name', 'text', 100],
          ['email', 'Email', 'email', 200],
          ['phone_number', 'Phone (optional, a UserInfo claim)', 'tel', 50],
        ]
          .map(
            ([name, label, type, max]) =>
              `<label>${label}<input form="idp-register" type="${type}" name="${name}" maxlength="${max}"${name !== 'phone_number' ? ' required' : ''}></label>`,
          )
          .join(
            '',
          )}</div><button type="submit" form="idp-register" name="subject" value="new">Continue as a new user</button></section>`
      : '';
    const requester = new URL(params.redirect_uri).origin,
      content = chooserResults(report, parameters, action, chooserWork),
      heading =
        provider.caption && provider.caption !== provider.key ? `${provider.caption} (${provider.key})` : provider.key;
    const head =
      `<link rel="stylesheet" href="/_idp/persona-chooser.css"><script type="module" src="/_idp/persona-chooser-client.mjs"></script>` +
      assets
        .map((asset) =>
          asset.kind === 'scripts'
            ? `<script data-sim-local-only="identity-provider" src="${escapeHtml(asset.url)}"></script>`
            : `<link data-sim-local-only="identity-provider" rel="stylesheet" href="${escapeHtml(asset.url)}">`,
        )
        .join('');
    return page(
      `<div data-persona-chooser data-scope="${escapeHtml(report.scope ?? 'local')}" data-presentation="${presentation}" role="${presentation === 'dialog' ? 'dialog' : 'main'}" aria-labelledby="chooser-title" style="--persona-accent:${settings.accentColor}"><header class="chooser-header"><div class="chooser-toolbar"><span class="chooser-kicker">Local identity provider · simulation</span><button type="button" data-chooser-display>${presentation === 'dialog' ? 'Use full page' : 'Open as dialog'}</button></div><h1 id="chooser-title">${escapeHtml(settings.title)}</h1><p>${escapeHtml(settings.description)}</p><p class="chooser-meta">Signing in to ${escapeHtml(requester)} with ${escapeHtml(heading)} · local simulation, no credentials are used</p>${fullPicker ? `<a href="${escapeHtml(fullPicker)}" target="_blank" rel="noopener">Open full persona picker and isolated setups</a>` : ''}</header>${chooserSearch(report, parameters, action, hidden, chooserWork)}<p class="chooser-error" data-chooser-error role="alert"></p><form method="post" action="${action}" id="idp-choose">${hidden}</form>${params.prompt.split(/\s+/).includes('create') ? create + content : content + create}${requested ? `<details class="chooser-request"><summary>Authorization request details</summary><dl aria-label="Request">${requested}</dl></details>` : ''}</div>`, // NOSONAR: preserve template coercion and selected evaluation
      { head },
    );
  };
  const presetUsers = async (provider) => (await users(provider)) ?? [];
  const hinted = (list, hint) => {
    const value = normalizeHint(hint);
    if (!value) return null;
    return (
      list.find((user) =>
        [user.contactId, user.subject, user.email, ...(user.hints ?? [])].some(
          (candidate) => normalizeHint(candidate) === value,
        ),
      ) ?? null
    );
  };
  /** The provider's signed-in user in this browser (its session cookie), for prompt=none. */
  const sessionUser = (req, provider) => {
    const entry = sessions.get(sessionCookie(req) ?? '');
    return entry && entry.provider === provider.slug ? entry.user : null;
  };

  // ---- token endpoint: client authentication and the code grant
  /** The client's authentication at the token endpoint, as the provider registration expects; an error message or null. */
  function /* NOSONAR */ authenticateClient(provider, form) {
    // NOSONAR: preserve state, evaluation order, and lifecycle
    const method = provider.tokenAuthMethod === 'private_key_jwt' ? 'private_key_jwt' : 'client_secret_post';
    if (method === 'client_secret_post') {
      if (form.client_assertion) return 'This client is registered for client_secret_post, not a client assertion.';
      if (form.client_id !== provider.clientId)
        return `The client_id "${form.client_id ?? ''}" is not registered for this provider.`;
      if (!provider.clientSecret)
        return "No client secret is registered for this client: set the provider's ClientSecret site setting.";
      if (form.client_secret !== provider.clientSecret) return 'The client secret is wrong.';
      return null;
    }
    if (form.client_assertion_type !== CLIENT_ASSERTION_TYPE || !form.client_assertion)
      return `This client is registered for private_key_jwt: send a client_assertion of type ${CLIENT_ASSERTION_TYPE}.`;
    const jwt = decodeJwt(form.client_assertion);
    if (!jwt) return 'The client assertion is not a JSON Web Token.';
    const key = (provider.clientKeys ?? []).find((item) => item.kid === jwt.header.kid);
    if (jwt.header.alg !== 'RS256' || !key)
      return `The client assertion is not signed with a registered key (kid "${jwt.header.kid ?? ''}").`;
    let signed;
    try {
      signed = verify(
        'sha256',
        Buffer.from(`${jwt.parts[0]}.${jwt.parts[1]}`),
        createPublicKey({ key, format: 'jwk' }),
        Buffer.from(jwt.parts[2], 'base64url'),
      );
    } catch {
      signed = false;
    }
    if (!signed) return 'The client assertion signature is invalid.';
    const { iss, sub, aud, exp, jti } = jwt.claims;
    if (iss !== provider.clientId || sub !== provider.clientId)
      return "The client assertion's iss and sub must be the client_id.";
    if (form.client_id && form.client_id !== provider.clientId)
      return 'The client_id does not match the client assertion.';
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(tokenEndpoint(provider)) && !audiences.includes(authority(provider)))
      return "The client assertion's audience is not this token endpoint.";
    const now = clock() / 1000;
    if (!(Number(exp) > now - 60)) return 'The client assertion has expired.'; // NOSONAR: the negated comparison preserves NaN behavior
    if (typeof jti !== 'string' || !jti) return 'The client assertion has no jti.';
    if (assertions.has(`${provider.slug}|${jti}`)) return 'The client assertion was already used (jti replay).';
    remember(assertions, `${provider.slug}|${jti}`, clock());
    return null;
  }
  async function token(req, res, provider) {
    const form = await readForm(req);
    if (form.grant_type !== 'authorization_code')
      return tokenError(
        res,
        'unsupported_grant_type',
        `grant_type "${form.grant_type ?? ''}" is not supported; this provider redeems authorization codes.`,
      );
    const clientProblem = authenticateClient(provider, form);
    if (clientProblem) return tokenError(res, 'invalid_client', clientProblem);
    const entry = codes.get(String(form.code ?? ''));
    if (!entry || entry.slug !== provider.slug)
      return tokenError(res, 'invalid_grant', 'The authorization code is unknown.');
    codes.delete(String(form.code));
    if (entry.used || clock() > entry.expires)
      return tokenError(res, 'invalid_grant', 'The authorization code has expired or was already redeemed.');
    if (form.redirect_uri !== entry.redirectUri)
      return tokenError(res, 'invalid_grant', 'The redirect_uri is not the one the code was issued for.');
    if (entry.clientId !== provider.clientId)
      return tokenError(res, 'invalid_grant', 'The code was issued to another client.');
    const pkce = verifyPkce(entry, form.code_verifier);
    if (pkce) return tokenError(res, 'invalid_grant', pkce);
    const params = {
      client_id: entry.clientId,
      nonce: entry.nonce ?? '',
      acr_values: entry.acr ?? '',
      scope: entry.scope,
    };
    const accessToken = issueAccessToken(provider, params, entry.user);
    return json(res, 200, {
      token_type: 'Bearer',
      access_token: accessToken,
      expires_in: TOKEN_LIFETIME_S,
      scope: entry.scope,
      // An OAuth 2.0 provider issues no id_token: the portal reads the user profile with the access token.
      ...(provider.type === 'oauth2'
        ? {}
        : { id_token: await signToken(idTokenClaims(provider, params, entry.user, { accessToken })) }),
    });
  }
  function userinfo(req, res, provider) {
    const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    const entry = bearer ? accessTokens.get(bearer) : null;
    if (!entry || entry.slug !== provider.slug || clock() > entry.expires)
      return json(
        res,
        401,
        {
          error: 'invalid_token',
          error_description: bearer ? 'The access token is unknown or expired.' : 'A Bearer access token is required.',
        },
        { 'www-authenticate': `Bearer error="invalid_token"` },
      );
    return json(res, 200, userInfoClaims(entry.user));
  }

  /** The user the chooser's form names: a preset user (its identity recorded first) or a new user; null after a refusal. */
  async function chosenUser(res, provider, params, form, list) {
    if (form.subject === 'new') {
      if (siteAdmission(params)) {
        fail(res, 403, 'Private site admission requires an existing local identity.');
        return null;
      }
      const policy = newUserPolicy(settings, registration(), provider, params);
      if (!policy.allowed) {
        fail(
          res,
          403,
          'Registration is disabled by ' + (policy.disabled.join(', ') || 'mirage.identityProvider.newUser=never'),
        );
        return null;
      }
      const email = String(form.email ?? '').trim();
      const given = String(form.given_name ?? '').trim();
      const family = String(form.family_name ?? '').trim();
      const phone = String(form.phone_number ?? '').trim();
      if (
        !email.includes('@') ||
        !given ||
        !family ||
        email.length > 200 ||
        given.length > 100 ||
        family.length > 100 ||
        phone.length > 50
      ) {
        fail(res, 400, 'A new user needs a given name, a family name and an email address.');
        return null;
      }
      return {
        subject: randomUUID(),
        email,
        givenName: given,
        familyName: family,
        name: `${given} ${family}`,
        ...(phone ? { phone } : {}),
      };
    }
    const user = list.find((item) => item.subject === form.subject);
    if (!user) {
      fail(res, 400, 'Choose one of the preset users.');
      return null;
    }
    if (!siteAdmission(params)) await provision(provider, user);
    return user;
  }
  /** Ends this browser's provider session and follows `target` when the portal's origin holds it. */
  function endSession(req, res, target, extra = {}) {
    const current = sessionCookie(req);
    if (current) sessions.delete(current);
    const cleared = { 'set-cookie': `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` };
    if (target && allowRedirect(target)) {
      const next = new URL(target);
      for (const [name, value] of Object.entries(extra)) if (value) next.searchParams.set(name, value);
      res.writeHead(302, { ...cleared, location: next.href, 'cache-control': 'no-store' });
      return res.end();
    }
    return respond(
      res,
      200,
      page(
        `<h1>${TITLE}</h1><p class="note">Signed out of the local identity provider.</p>${target ? `<p role="alert">The sign-out reply URL is not on the portal's origin and was not followed.</p>` : ''}`, // NOSONAR: preserve template coercion and selected evaluation
      ),
      cleared,
    );
  }

  /** The provider list's link to a provider's metadata: federation metadata or the OpenID Connect discovery document. */
  const metadataLink = (provider) => {
    const federated = FEDERATED.has(provider.type);
    const target = federated ? 'federationmetadata/2007-06/federationmetadata.xml' : '.well-known/openid-configuration';
    return `<a href="/${escapeHtml(provider.slug)}/${target}">${federated ? 'Federation metadata' : 'Discovery document'}</a>`;
  };

  // ---- SAML 2.0 and WS-Federation ----
  const ssoUrl = (provider) => `${authority(provider)}saml2`;
  const sloUrl = (provider) => `${authority(provider)}saml2/logout`;
  const passiveUrl = (provider) => `${authority(provider)}wsfed`;
  /** The claims of a user as SAML attributes (System.Security.Claims.ClaimTypes names). */
  const federatedClaims = (user) => {
    const { name, given, family } = nameParts(user);
    return {
      [CLAIM_TYPES.name]: name,
      ...(given ? { [CLAIM_TYPES.givenName]: given } : {}),
      ...(family ? { [CLAIM_TYPES.surname]: family } : {}),
      ...(user.email ? { [CLAIM_TYPES.email]: user.email } : {}),
      ...(user.phone ? { [CLAIM_TYPES.mobilePhone]: user.phone } : {}),
    };
  };
  /** The AuthnRequest of the redirect (or of the chooser's form), checked against the service provider registration. */
  function samlRequestOf(provider, encoded) {
    const request = readAuthnRequest(inflateMessage(encoded));
    if (request.issuer !== provider.clientId)
      throw new FederationProblem(
        `The AuthnRequest issuer "${request.issuer ?? ''}" is not the registered service provider realm (${provider.clientId}).`,
      );
    if (request.destination && request.destination !== ssoUrl(provider))
      throw new FederationProblem('The AuthnRequest is addressed to another endpoint.');
    if ((request.acs ?? provider.redirectUri) !== provider.redirectUri)
      throw new FederationProblem(
        `The AssertionConsumerServiceURL "${request.acs}" is not the registered reply URL (${provider.redirectUri}).`,
      );
    if (request.binding && request.binding !== SAML.post)
      throw new FederationProblem('This provider answers with the HTTP-POST binding only.');
    if (request.nameIdFormat && ![SAML.persistent, SAML.unspecified].includes(request.nameIdFormat))
      throw new FederationProblem('This provider issues persistent name identifiers only.');
    return request;
  }
  /** The signed Response for `user` (or, with `subStatus`, an unsuccessful one), posted to the reply URL. */
  async function samlAnswer(res, provider, { user = null, request, relayState, subStatus = null }) {
    const { privateKey } = await signingKey();
    const now = clock();
    const sessionIndex = messageId();
    const inResponseTo = request?.id ?? null;
    const assertion = user
      ? signedAssertion({
          issuer: provider.id,
          subject: user.subject,
          audience: provider.clientId,
          claims: federatedClaims(user),
          recipient: provider.redirectUri,
          inResponseTo,
          sessionIndex,
          now,
          privateKey,
        })
      : '';
    const response = signedResponse({
      issuer: provider.id,
      destination: provider.redirectUri,
      inResponseTo,
      assertion,
      ...(subStatus ? { status: SAML.responder, subStatus } : {}),
      now,
      privateKey,
    });
    return deliver(
      res,
      { redirect_uri: provider.redirectUri, response_mode: 'form_post' },
      { SAMLResponse: postMessage(response), ...(relayState ? { RelayState: relayState } : {}) },
      user ? startSession(provider, user, sessionIndex) : {},
    );
  }
  /**
   * The AuthnRequest's IsPassive (saml-core-2.0-os 3.4.1): no page; this browser's provider session answers, else a
   * Responder/NoPassive status. With ForceAuthn as well, the session cannot answer, so the status is NoPassive.
   */
  function samlPassive(req, res, provider, request, relayState) {
    const user = request.forceAuthn ? null : sessionUser(req, provider);
    return samlAnswer(res, provider, { user, request, relayState, ...(user ? {} : { subStatus: SAML.noPassive }) });
  }
  async function samlSignOn(req, res, provider, url, unsolicited) {
    const form = req.method === 'POST' ? await readForm(req) : Object.fromEntries(url.searchParams);
    const relayState = typeof form.RelayState === 'string' && form.RelayState.length <= 1024 ? form.RelayState : '';
    const request = unsolicited ? null : samlRequestOf(provider, form.SAMLRequest);
    if (req.method === 'GET' && request?.passive) return samlPassive(req, res, provider, request, relayState);
    const params = {
      redirect_uri: provider.redirectUri,
      prompt: '',
      acr_values: '',
      ...(request ? { SAMLRequest: form.SAMLRequest } : {}),
      RelayState: relayState,
    };
    const list = await presetUsers(provider);
    // ForceAuthn: a fresh authentication; the chooser answers it and never this browser's earlier session.
    const details = request?.forceAuthn ? { ForceAuthn: 'true' } : {};
    if (req.method === 'GET')
      return respond(
        res,
        200,
        chooser(provider, params, details, list, url.searchParams, unsolicited ? 'saml2/idpinitiated' : 'saml2'),
      );
    const user = await chosenUser(res, provider, params, form, list);
    return user ? samlAnswer(res, provider, { user, request, relayState }) : undefined;
  }
  /** A LogoutRequest signed with the key registered for the site's logout certificate; answered with a signed LogoutResponse. */
  async function samlLogout(req, res, provider, url) {
    const keys = (provider.logoutKeys ?? []).map((key) => createPublicKey({ key, format: 'jwk' }));
    if (!keys.length)
      throw new FederationProblem(
        'No logout certificate is registered for this service provider (ExternalLogoutCertThumbprint).',
      );
    const { message, relayState } = verifyRedirectQuery(url.search.slice(1), 'SAMLRequest', keys);
    const request = readLogoutRequest(message);
    if (request.issuer !== provider.clientId)
      throw new FederationProblem('The LogoutRequest is not issued by the registered service provider.');
    if (request.destination !== sloUrl(provider))
      throw new FederationProblem('The LogoutRequest is addressed to another endpoint.');
    const current = sessionCookie(req);
    const entry = sessions.get(current ?? '');
    if (entry?.provider === provider.slug && entry.subject === request.nameId) sessions.delete(current);
    const { privateKey } = await signingKey();
    const query = signedRedirectQuery(
      'SAMLResponse',
      logoutResponseXml({
        issuer: provider.id,
        destination: provider.redirectUri,
        inResponseTo: request.id,
        now: clock(),
      }),
      relayState,
      privateKey,
    );
    res.writeHead(302, {
      location: provider.redirectUri + (provider.redirectUri.includes('?') ? '&' : '?') + query,
      'cache-control': 'no-store',
      'set-cookie': `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    });
    return res.end();
  }
  /** The passive requestor endpoint: wa=wsignin1.0 for the registered wtrealm and wreply, wa=wsignout1.0. */
  async function wsFederation(req, res, provider, url) {
    const form = req.method === 'POST' ? await readForm(req) : Object.fromEntries(url.searchParams);
    const wa = String(form.wa ?? '');
    if (wa === 'wsignout1.0' || wa === 'wsignoutcleanup1.0') return endSession(req, res, form.wreply);
    if (wa !== 'wsignin1.0') throw new FederationProblem(`wa "${wa}" is not wsignin1.0 or wsignout1.0.`);
    if (form.wtrealm !== provider.clientId)
      throw new FederationProblem(
        `The wtrealm "${form.wtrealm ?? ''}" is not registered for this provider (expected "${provider.clientId}").`,
      );
    const reply = form.wreply || provider.redirectUri;
    if (reply !== provider.redirectUri)
      throw new FederationProblem(`The wreply "${reply}" is not the provider's registered reply URL.`);
    const wctx = typeof form.wctx === 'string' && form.wctx.length <= 2048 ? form.wctx : '';
    const whr = typeof form.whr === 'string' ? form.whr.slice(0, 256) : '';
    const params = {
      redirect_uri: reply,
      prompt: '',
      acr_values: '',
      wa,
      wtrealm: form.wtrealm,
      wreply: form.wreply ?? '',
      wctx,
    };
    const list = await presetUsers(provider);
    if (req.method === 'GET')
      return respond(res, 200, chooser(provider, params, whr ? { whr } : {}, list, url.searchParams, 'wsfed'));
    const user = await chosenUser(res, provider, params, form, list);
    if (!user) return undefined;
    const { privateKey } = await signingKey();
    const now = clock();
    const assertion = signedAssertion({
      issuer: provider.id,
      subject: user.subject,
      audience: provider.clientId,
      claims: federatedClaims(user),
      now,
      privateKey,
    });
    return deliver(
      res,
      { redirect_uri: reply, response_mode: 'form_post' },
      {
        wa: 'wsignin1.0',
        wresult: wsFederationResult({ assertion, realm: provider.clientId, now }),
        ...(wctx ? { wctx } : {}),
      },
      startSession(provider, user),
    );
  }
  // ---- OAuth 1.0a (the Twitter provider) ----
  const oauth1 = createOauth1Provider({ clock: () => clock() });
  /** A Twitter-style screen name of a user: letters, digits and underscores, at most 15. */
  const screenNameOf = (user) =>
    String(user.email?.split('@')[0] ?? user.name ?? user.subject)
      .replace(/\W/g, '_')
      .slice(0, 15) || 'user';
  const formAnswer = (res, fields) => {
    res.writeHead(200, {
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return res.end(new URLSearchParams(fields).toString());
  };
  /** POST oauth/request_token, GET and POST oauth/authenticate, POST oauth/access_token. */
  async function oauth1Route(req, res, provider, route, url) {
    const signed = async () => ({
      method: req.method,
      url: url.href,
      header: req.headers.authorization,
      body: req.method === 'POST' ? await readForm(req) : {},
    });
    if (req.method === 'POST' && route === 'oauth/request_token')
      return formAnswer(res, oauth1.requestToken(provider, await signed()));
    if (req.method === 'POST' && route === 'oauth/access_token')
      return formAnswer(res, oauth1.accessToken(provider, await signed()));
    if (route !== 'oauth/authenticate' || !['GET', 'POST'].includes(req.method))
      return fail(res, 404, 'Unknown identity provider endpoint.');
    const form = req.method === 'POST' ? await readForm(req) : Object.fromEntries(url.searchParams);
    if (!oauth1.pendingToken(provider, form.oauth_token))
      return fail(res, 400, 'The request token is unknown, expired or already authorized.');
    const params = { redirect_uri: provider.redirectUri, prompt: '', acr_values: '', oauth_token: form.oauth_token };
    const list = await presetUsers(provider);
    if (req.method === 'GET')
      return respond(res, 200, chooser(provider, params, {}, list, url.searchParams, 'oauth/authenticate'));
    const user = await chosenUser(res, provider, params, form, list);
    if (!user) return undefined;
    const location = oauth1.authorize(provider, form.oauth_token, { ...user, screenName: screenNameOf(user) });
    res.writeHead(302, { location, 'cache-control': 'no-store', ...startSession(provider, user) });
    return res.end();
  }

  async function federated(req, res, provider, route, url) {
    if (req.method === 'GET' && route === 'federationmetadata/2007-06/federationmetadata.xml') {
      const { jwk } = await signingKey();
      res.writeHead(200, {
        'content-type': 'application/samlmetadata+xml; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      return res.end(
        identityProviderMetadata({
          protocol: provider.type,
          entityId: provider.id,
          jwk,
          endpoint: provider.type === 'saml2' ? ssoUrl(provider) : passiveUrl(provider),
          logoutEndpoint: sloUrl(provider),
        }),
      );
    }
    const methods = ['GET', 'POST'].includes(req.method);
    if (provider.type === 'saml2' && methods && route === 'saml2') return samlSignOn(req, res, provider, url, false);
    if (provider.type === 'saml2' && methods && route === 'saml2/idpinitiated')
      return samlSignOn(req, res, provider, url, true);
    if (provider.type === 'saml2' && req.method === 'GET' && route === 'saml2/logout')
      return samlLogout(req, res, provider, url);
    if (provider.type === 'wsfederation' && methods && route === 'wsfed') return wsFederation(req, res, provider, url);
    return fail(res, 404, 'Unknown identity provider endpoint.');
  }

  async function /* NOSONAR */ handle(req, res) {
    // NOSONAR: preserve state, evaluation order, and lifecycle
    const url = new URL(req.url, origin);
    if (
      req.method === 'GET' &&
      (builtinAssets.has(url.pathname) || assets.some((asset) => asset.url === url.pathname))
    ) {
      const asset = assets.find((item) => item.url === url.pathname);
      let bytes = builtinAssets.get(url.pathname);
      if (asset) {
        const real = await fs.realpath(asset.file),
          relative = path.relative(asset.root, real);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
          return fail(res, 403, 'Local identity-provider assets must remain inside the project');
        bytes = await fs.readFile(real);
      }
      res.writeHead(200, {
        'content-type': url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      return res.end(bytes);
    }
    if (req.method === 'GET' && url.pathname === '/') {
      const items = providers()
        .map(
          (provider) =>
            `<li><span><strong>${escapeHtml(provider.caption ?? provider.key)}</strong> <small>${escapeHtml(provider.key)}</small><br><code>${escapeHtml(authority(provider))}</code></span>${metadataLink(provider)}</li>`,
        )
        .join('');
      return respond(
        res,
        200,
        page(
          `<h1>${TITLE}</h1><p class="note">Serves the portal's external sign-in on this machine only.</p><ul aria-label="Providers">${items || '<li>No external identity provider is configured in the site settings.</li>'}</ul>`,
        ),
      );
    }
    const [, slug, ...rest] = url.pathname.split('/');
    const route = rest.join('/');
    const provider = SLUG.test(slug ?? '') ? (providers().find((item) => item.slug === slug) ?? null) : null;
    if (!provider) return fail(res, 404, 'Unknown provider.');
    if (provider.protocol === 'oauth1')
      try {
        return (await oauth1Route(req, res, provider, route, url)) ?? undefined;
      } catch (error) {
        if (!(error instanceof Oauth1Problem)) throw error;
        refusals.set(res, { code: 'IdentityProviderRequestRejected', message: error.message });
        return json(res, error.status, { error: error.message });
      }
    if (FEDERATED.has(provider.type)) {
      try {
        return (await federated(req, res, provider, route, url)) ?? undefined;
      } catch (error) {
        if (error instanceof FederationProblem) return fail(res, 400, error.message);
        throw error;
      }
    }
    if (req.method === 'GET' && route === '.well-known/openid-configuration')
      return json(res, 200, {
        issuer: authority(provider),
        authorization_endpoint: `${authority(provider)}oauth2/authorize`,
        token_endpoint: tokenEndpoint(provider),
        userinfo_endpoint: `${authority(provider)}openid/userinfo`,
        end_session_endpoint: `${authority(provider)}oauth2/logout`,
        jwks_uri: `${authority(provider)}discovery/keys`,
        response_types_supported: RESPONSE_TYPES,
        response_modes_supported: ['form_post', 'query'],
        grant_types_supported: ['authorization_code', 'implicit'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256', 'plain'],
        prompt_values_supported: PROMPTS,
        scopes_supported: ['openid', 'profile', 'email', 'phone'],
        claims_supported: [
          'aud',
          'iss',
          'iat',
          'nbf',
          'exp',
          'acr',
          'at_hash',
          'c_hash',
          'email',
          'email_verified',
          'preferred_username',
          'family_name',
          'given_name',
          'name',
          'nonce',
          'oid',
          'phone_number',
          'sub',
        ],
      });
    if (req.method === 'GET' && route === 'discovery/keys') {
      const { jwk, kid } = await signingKey();
      return json(res, 200, { keys: [{ kty: jwk.kty, use: 'sig', kid, alg: 'RS256', n: jwk.n, e: jwk.e }] });
    }
    if (req.method === 'POST' && route === 'oauth2/token') return token(req, res, provider);
    if (['GET', 'POST'].includes(req.method) && route === 'openid/userinfo') return userinfo(req, res, provider);
    if (route === 'oauth2/authorize' && ['GET', 'POST'].includes(req.method)) {
      const form = req.method === 'POST' ? await readForm(req) : Object.fromEntries(url.searchParams);
      const params = authorizeParams(form);
      // An OAuth 2.0 authorization code comes back on the query string (RFC 6749 4.1.2).
      if (provider.type === 'oauth2' && !params.response_mode) params.response_mode = 'query';
      const extras = extrasOf(form);
      const problem = validateAuthorize(provider, params);
      if (problem) return fail(res, 400, problem);
      const list = await presetUsers(provider);
      if (req.method === 'GET') {
        const prompts = params.prompt.split(/\s+/).filter(Boolean);
        if (prompts.includes('none')) {
          // No page: the hinted user or this browser's provider session, else login_required.
          const silent = hinted(list, params.login_hint) ?? sessionUser(req, provider);
          if (!silent)
            return deny(
              res,
              params,
              'login_required',
              'prompt=none: no user is signed in to the local identity provider in this browser and login_hint names no preset user.',
            );
          if (silent.contactId && !siteAdmission(params)) await provision(provider, silent);
          return answer(res, provider, params, silent);
        }
        const match = prompts.length ? null : hinted(list, params.login_hint);
        if (!match) return respond(res, 200, chooser(provider, params, extras, list, url.searchParams));
        if (!siteAdmission(params)) await provision(provider, match);
        return answer(res, provider, params, match);
      }
      const user = await chosenUser(res, provider, params, form, list);
      return user ? answer(res, provider, params, user) : undefined;
    }
    if (req.method === 'GET' && route === 'oauth2/logout')
      return endSession(req, res, url.searchParams.get('post_logout_redirect_uri'), {
        state: url.searchParams.get('state'),
      });
    return fail(res, 404, 'Unknown identity provider endpoint.');
  }
  const serve = (req, res) =>
    handle(req, res).catch((error) => {
      if (!res.headersSent) fail(res, error.status ?? 500, error.message);
      else res.end();
    });
  const server = http.createServer((req, res) => {
    if (!traces?.enabled) return serve(req, res);
    const span = traces.start({
      kind: 'http',
      name: `${req.method} ${String(req.url ?? '/').split('?')[0]}`,
      module: 'identity',
      operation: req.method,
      ...ANONYMOUS_ROOT,
      origin: { host: 'identity-provider', portal: null, preset: null },
      ...traces.fromHeaders(req.headers),
    });
    setTraceHeaders(res, span);
    res.on('close', () => {
      if (!res.writableFinished)
        span.end({
          status: 'error',
          error: { code: 'REQUEST_ABORTED', message: 'The client closed the request before completion.' },
          attributes: { statusCode: 499 },
        });
    });
    res.on('finish', () => {
      recordHttpError(span, res.statusCode, refusals.get(res));
      span.end({ attributes: { statusCode: res.statusCode } });
    });
    return traces.run(span, () => serve(req, res));
  });
  keepIdleConnections(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port }, resolve);
  });
  origin = `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`;
  // Browsers share cookies across ports: the provider's session cookie carries its port.
  cookieName = `paqvilo-mirage-idp-${server.address().port}`;
  return {
    get origin() {
      return origin;
    },
    get port() {
      return server.address()?.port ?? null;
    },
    /** The provider's local authority (its issuer), http://<host>:<port>/<slug>/. */
    authority,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
