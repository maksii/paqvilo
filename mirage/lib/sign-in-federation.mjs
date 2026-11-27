import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  authnRequestXml,
  CLAIM_TYPES,
  createReplayCache,
  deflateMessage,
  FederationProblem,
  logoutRequestXml,
  messageId,
  readIdentityProviderMetadata,
  readLogoutResponse,
  readPostMessage,
  responseIssuer,
  SAML,
  signedRedirectQuery,
  validateSamlResponse,
  validateWsFederationResult,
  verifyRedirectQuery,
} from './identity-federation.mjs';
import { parseCookies, safeReturnUrl } from './auth-session.mjs';
import { signedAuthorization } from './identity-oauth1.mjs';
import { stripTrailingCharacter } from './text-scanning.mjs';

/**
 * The portal side of the OAuth 2.0, SAML 2.0 and WS-Federation providers (lib/external-login.mjs types oauth2, saml2
 * and wsfederation) against the local identity provider (lib/identity-provider.mjs).
 *
 * - OAuth 2.0 (the OWIN OAuth middlewares the platform's Microsoft, Google, Facebook and LinkedIn providers build on):
 *   the authorize redirect with response_type code, the code redeemed at the token endpoint with the client secret,
 *   and the user profile read with the access token, as ClaimTypes claims (NameIdentifier, Name, GivenName, Surname,
 *   Email).
 * - SAML 2.0: an unsigned AuthnRequest with the HTTP-Redirect binding (Learn, SAML 2.0 FAQ: Power Pages does not sign
 *   it), the signed Response posted to the assertion consumer service URL, validated by validateSamlResponse with the
 *   signing keys of the provider's metadata; an identity-provider-initiated response carries RelayState
 *   `ReturnUrl=<path>` (Learn, "Set up a SAML 2.0 provider with AD FS"). With ExternalLogoutCertThumbprint, sign-out
 *   sends a LogoutRequest signed with the local stand-in for that certificate and accepts the signed LogoutResponse.
 * - WS-Federation: wa=wsignin1.0 with wtrealm, wreply, wctx and whr (Whr), the posted wresult validated by
 *   validateWsFederationResult; sign-out sends wa=wsignout1.0 with wreply.
 *
 * Each started sign-in or sign-out is a pending entry: a protected, browser-bound cookie named after the message's
 * RelayState, wctx or state, kept 15 minutes and cleared by its answer, so an answer completes only in the browser that
 * started it. Assertion IDs are kept until they expire (replay).
 */

const PENDING_LIFETIME_MS = 15 * 60 * 1000;
const PENDING_ID = /^[\w-]{16,64}$/;
/** The pending entry name of a Twitter sign-in: its provider's, never a value the provider sent. */
const twitterPendingId = (provider) => `twitter-pending-${provider.slug}`.slice(0, 64);
const sameText = (a, b) => {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
};
const trimPath = (value) => stripTrailingCharacter(String(value ?? ''), '/').toLowerCase() || '/';
const withQuery = (base, fields) => {
  const target = new URL(base);
  for (const [name, value] of Object.entries(fields)) if (value) target.searchParams.set(name, value);
  return target.href;
};
const problem = (message, code, status = 400) => Object.assign(new FederationProblem(message, code), { status });

/** The return URL an identity-provider-initiated RelayState names (`ReturnUrl=<path>`), else the site root. */
function relayStateReturnUrl(relayState) {
  if (typeof relayState !== 'string' || !relayState.includes('=')) return '/';
  for (const [name, value] of new URLSearchParams(relayState))
    if (name.toLowerCase() === 'returnurl') return safeReturnUrl(value);
  return '/';
}

/**
 * - now(), origin(), identityProvider(): the clock, the portal's origin and the running local identity provider.
 * - protect/unprotect/mac: the sign-in flow's data protection. redirectUri(provider): the provider's reply URL.
 * - providers(): the configured providers. fetchProvider(operation, url, init, capture): a traced fetch.
 * - logoutKey(): the key pair standing in for the site's custom certificate (ExternalLogoutCertThumbprint).
 */
export function createFederatedSignIn({
  now,
  origin,
  identityProvider,
  protect,
  unprotect,
  mac,
  redirectUri,
  providers,
  fetchProvider,
  logoutKey,
  readGuardMs = 60_000,
}) {
  const replay = createReplayCache();
  const metadataCache = new Map();
  const pendingName = (id) => `paqvilo-mirage-federation-${new URL(origin()).port}.${mac('pending:' + id)}`;
  const pendingCookie = (id, data) =>
    `${pendingName(id)}=${protect({ ...data, id, t: now() })}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${PENDING_LIFETIME_MS / 1000}`;
  const clearPending = (id) => `${pendingName(id)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  function readPending(req, id) {
    if (typeof id !== 'string' || !PENDING_ID.test(id)) return null;
    const data = unprotect(parseCookies(req.headers.cookie)[pendingName(id)]);
    return data?.id === id && now() - Number(data.t) < PENDING_LIFETIME_MS ? data : null;
  }
  const authority = (provider) => {
    const idp = identityProvider();
    if (!idp) throw problem('The local identity provider is not running.', 'EXTERNAL_LOGIN_PROVIDER_UNAVAILABLE', 503);
    return idp.authority(provider);
  };

  async function read(operation, target, init = {}, capture = 'full') {
    let response;
    try {
      response = await fetchProvider(operation, target, { ...init, signal: AbortSignal.timeout(readGuardMs) }, capture);
    } catch (error) {
      throw problem(
        `The identity provider at ${target} is not reachable (${error.message}).`,
        'EXTERNAL_LOGIN_METADATA_UNAVAILABLE',
        502,
      );
    }
    return response;
  }
  /** The provider's federation metadata (entity ID, signing keys, endpoints), read from the local identity provider. */
  async function metadata(provider) {
    const address = `${authority(provider)}federationmetadata/2007-06/federationmetadata.xml`;
    const cached = metadataCache.get(provider.slug);
    if (cached?.address === address) return cached;
    const response = await read('metadata', address);
    if (!response.ok)
      throw problem(
        `The identity provider answered ${response.status} for ${address}.`,
        'EXTERNAL_LOGIN_METADATA_UNAVAILABLE',
        502,
      );
    const meta = readIdentityProviderMetadata(await response.text());
    if (meta.entityId !== provider.id)
      throw problem(
        `The identity provider's metadata names the entity ${meta.entityId ?? '(none)'}, not the AuthenticationType ${provider.id}.`,
        'FEDERATION_ISSUER_INVALID',
        502,
      );
    if (!meta.keys.length)
      throw problem("The identity provider's metadata has no signing key.", 'FEDERATION_METADATA_INVALID', 502);
    const entry = { ...meta, address };
    metadataCache.set(provider.slug, entry);
    return entry;
  }

  // ---- the challenge ----
  /** The SAML 2.0 AuthnRequest redirect; the request ID joins the pending sign-in. */
  async function samlTarget(provider, id, props) {
    const meta = await metadata(provider);
    if (!meta.sso)
      throw problem(
        "The identity provider's metadata has no HTTP-Redirect SingleSignOnService.",
        'FEDERATION_METADATA_INVALID',
        502,
      );
    props.q = messageId();
    const xml = authnRequestXml({
      id: props.q,
      issuer: provider.clientId,
      destination: meta.sso,
      acs: redirectUri(provider),
      now: now(),
    });
    return { id, location: withQuery(meta.sso, { SAMLRequest: deflateMessage(xml), RelayState: id }) };
  }
  async function wsFederationTarget(provider, id) {
    const meta = await metadata(provider);
    if (!meta.passive)
      throw problem(
        "The identity provider's metadata has no passive requestor endpoint.",
        'FEDERATION_METADATA_INVALID',
        502,
      );
    const location = withQuery(meta.passive, {
      wa: 'wsignin1.0',
      wtrealm: provider.clientId,
      wreply: redirectUri(provider),
      wctx: id,
      wct: new Date(now()).toISOString(),
      whr: provider.homeRealm,
    });
    return { id, location };
  }
  /** OAuth 1.0a: a signed request for a request token, then the authorization redirect; the token names the pending sign-in. */
  async function twitterTarget(provider, props) {
    const url = `${authority(provider)}oauth/request_token`;
    const authorization = signedAuthorization({
      method: 'POST',
      url,
      consumerKey: provider.clientId,
      consumerSecret: provider.clientSecret ?? '',
      oauth: { oauth_callback: redirectUri(provider) },
      now: now(),
    });
    const response = await read(
      'request-token',
      url,
      { method: 'POST', headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' }, body: '' },
      'none',
    );
    const fields = Object.fromEntries(new URLSearchParams(await response.text()));
    if (!response.ok || fields.oauth_callback_confirmed !== 'true' || !PENDING_ID.test(fields.oauth_token ?? ''))
      throw problem(
        `The identity provider refused the request token (${response.status}).`,
        'EXTERNAL_LOGIN_TOKEN_REQUEST_FAILED',
        502,
      );
    props.s = fields.oauth_token_secret;
    props.o = fields.oauth_token;
    return {
      id: twitterPendingId(provider),
      location: withQuery(`${authority(provider)}oauth/authenticate`, { oauth_token: fields.oauth_token }),
    };
  }
  function authorizationCodeTarget(provider, id) {
    const location = withQuery(`${authority(provider)}oauth2/authorize`, {
      client_id: provider.clientId,
      redirect_uri: redirectUri(provider),
      response_type: 'code',
      scope: provider.scope,
      state: id,
    });
    return { id, location };
  }
  /** The redirect to the provider for a sign-in (props: r return URL, i invitation code); answered through `redirect`. */
  async function challenge(res, provider, { returnUrl, invitationCode = null, cookies = [] }, redirect) {
    const state = randomBytes(18).toString('base64url');
    const props = { p: provider.slug, r: returnUrl, k: 'signin', ...(invitationCode ? { i: invitationCode } : {}) };
    let target;
    if (provider.type === 'saml2') target = await samlTarget(provider, state, props);
    else if (provider.type === 'wsfederation') target = await wsFederationTarget(provider, state);
    else if (provider.protocol === 'oauth1') target = await twitterTarget(provider, props);
    else target = authorizationCodeTarget(provider, state);
    return redirect(res, target.location, 'external-login', [pendingCookie(target.id, props), ...cookies]);
  }

  /**
   * The external sign-out of a provider, when it has one: SAML 2.0 with a logout certificate (a signed LogoutRequest
   * for `nameId`) and WS-Federation with ExternalLogoutEnabled (wsignout1.0). False when the provider signs out locally.
   */
  async function signOut(res, provider, { nameId, returnUrl, target, cookies }, redirect) {
    if (provider.type === 'saml2' && provider.logoutCertificate && nameId) {
      const meta = await metadata(provider);
      if (!meta.slo) return false;
      const id = randomBytes(18).toString('base64url');
      const requestId = messageId();
      const xml = logoutRequestXml({
        id: requestId,
        issuer: provider.clientId,
        destination: meta.slo,
        nameId,
        now: now(),
      });
      const query = signedRedirectQuery('SAMLRequest', xml, id, logoutKey().privateKey);
      return redirect(res, `${meta.slo}?${query}`, 'sign-out-external', [
        ...cookies,
        pendingCookie(id, { p: provider.slug, r: returnUrl, k: 'logout', q: requestId }),
      ]);
    }
    if (provider.type === 'wsfederation' && provider.externalLogout) {
      const meta = await metadata(provider);
      return redirect(
        res,
        withQuery(meta.passive, { wa: 'wsignout1.0', wreply: target }),
        'sign-out-external',
        cookies,
      );
    }
    return false;
  }

  // ---- answers at the reply URL ----
  const candidatesAt = (path) =>
    providers().filter((provider) => provider.type !== 'openidconnect' && trimPath(provider.callbackPath) === path);
  const failure = (error, pending, id) => ({
    kind: 'problem',
    problem: error,
    returnUrl: pending?.r ? safeReturnUrl(pending.r) : '/',
    cookies: pending ? [clearPending(id)] : [],
  });
  const audiencesOf = (provider) => [provider.clientId, ...(provider.validAudiences ?? [])];
  const signedIn = (provider, result, pending, id, returnUrl) => ({
    kind: 'signin',
    provider,
    subject: result.subject,
    claims: { ...result.claims, [CLAIM_TYPES.nameIdentifier]: result.subject },
    returnUrl,
    invitationCode: pending?.i ?? null,
    cookies: pending ? [clearPending(id)] : [],
  });

  async function samlAnswer(req, candidates, fields) {
    const id = typeof fields.RelayState === 'string' ? fields.RelayState : null;
    const pending = readPending(req, id);
    try {
      const xml = readPostMessage(fields.SAMLResponse);
      const issuer = pending ? null : responseIssuer(xml);
      const provider = candidates.find((item) =>
        pending ? item.slug === pending.p && pending.k === 'signin' : item.id === issuer,
      );
      if (provider?.type !== 'saml2')
        throw problem(
          'The SAML response does not answer a sign-in started in this browser or come from a SAML 2.0 provider of this reply URL.',
          'EXTERNAL_LOGIN_STATE_INVALID',
        );
      const meta = await metadata(provider);
      const result = validateSamlResponse(xml, {
        issuer: provider.id,
        keys: meta.keys,
        audiences: audiencesOf(provider),
        validateAudience: provider.validateAudience,
        acs: redirectUri(provider),
        requestId: pending?.q ?? null,
        now: now(),
        replay,
      });
      return signedIn(provider, result, pending, id, pending ? safeReturnUrl(pending.r) : relayStateReturnUrl(id));
    } catch (error) {
      if (error instanceof FederationProblem) return failure(error, pending, id);
      throw error;
    }
  }

  async function wsFederationAnswer(req, candidates, fields) {
    const id = fields.wctx;
    const pending = readPending(req, id);
    try {
      const provider = pending?.k === 'signin' ? candidates.find((item) => item.slug === pending.p) : null;
      if (provider?.type !== 'wsfederation')
        throw problem(
          'The sign-in response does not answer a sign-in started in this browser.',
          'EXTERNAL_LOGIN_STATE_INVALID',
        );
      if (fields.wa && fields.wa !== 'wsignin1.0')
        throw problem(`wa "${fields.wa}" is not wsignin1.0.`, 'FEDERATION_MESSAGE_INVALID');
      const meta = await metadata(provider);
      const result = validateWsFederationResult(fields.wresult, {
        issuer: provider.id,
        keys: meta.keys,
        audiences: audiencesOf(provider),
        validateAudience: provider.validateAudience,
        now: now(),
        replay,
      });
      return signedIn(provider, result, pending, id, safeReturnUrl(pending.r));
    } catch (error) {
      if (error instanceof FederationProblem) return failure(error, pending, id);
      throw error;
    }
  }

  async function logoutAnswer(req, url, candidates, fields) {
    const id = fields.RelayState;
    const pending = readPending(req, id);
    try {
      const provider = pending?.k === 'logout' ? candidates.find((item) => item.slug === pending.p) : null;
      if (provider?.type !== 'saml2')
        throw problem(
          'The logout response does not answer a sign-out started in this browser.',
          'EXTERNAL_LOGOUT_STATE_INVALID',
        );
      const meta = await metadata(provider);
      const { message } = verifyRedirectQuery(url.search.slice(1), 'SAMLResponse', meta.keys);
      const response = readLogoutResponse(message);
      if (response.issuer !== provider.id)
        throw problem('The logout response is not issued by the provider.', 'FEDERATION_ISSUER_INVALID');
      if (response.destination !== redirectUri(provider))
        throw problem(
          "The logout response's Destination is not this site's reply URL.",
          'FEDERATION_DESTINATION_INVALID',
        );
      if (response.inResponseTo !== pending.q)
        throw problem(
          'The logout response does not answer the logout request this browser sent.',
          'FEDERATION_REQUEST_MISMATCH',
        );
      if (response.status !== SAML.success)
        throw problem(
          `The identity provider answered the logout with ${response.status ?? '(no status)'}.`,
          'FEDERATION_STATUS',
        );
      return { kind: 'logout', returnUrl: safeReturnUrl(pending.r), cookies: [clearPending(id)] };
    } catch (error) {
      if (error instanceof FederationProblem) return failure(error, pending, id);
      throw error;
    }
  }

  /** The Twitter callback: oauth_token and oauth_verifier (or denied), exchanged for the user with a signed request. */
  async function twitterAnswer(req, candidates, fields) {
    // The pending Twitter sign-in of this browser whose request token the callback names.
    const found = candidates
      .filter((item) => item.protocol === 'oauth1')
      .map((item) => ({ item, id: twitterPendingId(item), pending: readPending(req, twitterPendingId(item)) }))
      .find(
        ({ item, pending }) =>
          pending?.k === 'signin' && pending.p === item.slug && sameText(pending.o, fields.oauth_token),
      );
    const { id = null, pending = null } = found ?? {};
    try {
      const provider = found?.item ?? null;
      if (provider?.protocol !== 'oauth1')
        throw problem(
          'The sign-in response does not answer a sign-in started in this browser.',
          'EXTERNAL_LOGIN_STATE_INVALID',
        );
      if (fields.denied || !fields.oauth_verifier)
        throw problem('The identity provider did not authorize the request token.', 'EXTERNAL_LOGIN_PROVIDER_ERROR');
      const answer = await twitterAccessToken(provider, pending.o, pending.s ?? '', String(fields.oauth_verifier));
      const screenName = String(answer.screen_name ?? '').slice(0, 256);
      const claims = {
        ...(screenName ? { [CLAIM_TYPES.name]: screenName, 'urn:twitter:screenname': screenName } : {}),
        'urn:twitter:userid': answer.user_id,
      };
      return signedIn(provider, { subject: answer.user_id, claims }, pending, id, safeReturnUrl(pending.r));
    } catch (error) {
      if (error instanceof FederationProblem) return failure(error, pending, id);
      throw error;
    }
  }
  /** POST oauth/access_token signed with the consumer secret and the request token secret. */
  async function twitterAccessToken(provider, token, tokenSecret, verifier) {
    const url = `${authority(provider)}oauth/access_token`;
    const body = { oauth_verifier: verifier };
    const authorization = signedAuthorization({
      method: 'POST',
      url,
      consumerKey: provider.clientId,
      consumerSecret: provider.clientSecret ?? '',
      token,
      tokenSecret,
      body,
      now: now(),
    });
    const response = await read(
      'access-token',
      url,
      {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
      },
      'none',
    );
    const answer = Object.fromEntries(new URLSearchParams(await response.text()));
    if (!response.ok || !answer.user_id || answer.user_id.length > 256)
      throw problem(
        `The identity provider refused the access token request (${response.status}).`,
        'EXTERNAL_LOGIN_TOKEN_REQUEST_FAILED',
        502,
      );
    return answer;
  }

  async function authorizationCodeAnswer(req, candidates, fields) {
    const id = fields.state;
    const pending = readPending(req, id);
    try {
      const provider = pending?.k === 'signin' ? candidates.find((item) => item.slug === pending.p) : null;
      if (provider?.type !== 'oauth2')
        throw problem(
          'The sign-in response does not answer a sign-in started in this browser.',
          'EXTERNAL_LOGIN_STATE_INVALID',
        );
      if (fields.error)
        throw problem(
          `The identity provider returned ${fields.error}${fields.error_description ? ': ' + fields.error_description : ''}.`,
          'EXTERNAL_LOGIN_PROVIDER_ERROR',
        );
      const profile = await userProfile(provider, String(fields.code ?? ''));
      if (typeof profile.sub !== 'string' || !profile.sub || profile.sub.length > 256)
        throw problem('The user profile has no identifier.', 'EXTERNAL_LOGIN_TOKEN_INVALID', 502);
      const text = (value) => (typeof value === 'string' && value.trim() && value.length <= 256 ? value.trim() : null);
      const claims = Object.fromEntries(
        [
          [CLAIM_TYPES.name, text(profile.name)],
          [CLAIM_TYPES.givenName, text(profile.given_name)],
          [CLAIM_TYPES.surname, text(profile.family_name)],
          [CLAIM_TYPES.email, text(profile.email)],
        ].filter(([, value]) => value),
      );
      return signedIn(provider, { subject: profile.sub, claims }, pending, id, safeReturnUrl(pending.r));
    } catch (error) {
      if (error instanceof FederationProblem) return failure(error, pending, id);
      throw error;
    }
  }

  /** The authorization code redeemed with the client secret, then the user profile read with the access token. */
  async function userProfile(provider, code) {
    const base = authority(provider);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(provider),
      client_id: provider.clientId,
      client_secret: provider.clientSecret ?? '',
    });
    const token = await read(
      'token',
      `${base}oauth2/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
      },
      'none',
    );
    const tokens = await token.json().catch(() => ({}));
    if (!token.ok || typeof tokens.access_token !== 'string')
      throw problem(
        `The identity provider refused the authorization code (${tokens.error ?? token.status}${tokens.error_description ? ': ' + tokens.error_description : ''}).`,
        'EXTERNAL_LOGIN_TOKEN_REQUEST_FAILED',
        502,
      );
    const response = await read('userinfo', `${base}openid/userinfo`, {
      headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' },
    });
    const profile = await response.json().catch(() => null);
    if (!response.ok || !profile || typeof profile !== 'object')
      throw problem(
        `The identity provider's user profile answered ${response.status}.`,
        'EXTERNAL_LOGIN_TOKEN_INVALID',
        502,
      );
    return profile;
  }

  /**
   * The provider answer at reply URL `path` of a non-OpenID Connect provider: { kind: 'signin' | 'logout' |
   * 'problem', ... }, or null when the request is not one (an OpenID Connect state, another form).
   */
  async function answer(req, url, path, fields) {
    const candidates = candidatesAt(path);
    if (!candidates.length) return null;
    const post = req.method === 'POST';
    if (post && typeof fields.SAMLResponse === 'string') return samlAnswer(req, candidates, fields);
    if (post && typeof fields.wresult === 'string') return wsFederationAnswer(req, candidates, fields);
    if (!post && typeof fields.SAMLResponse === 'string') return logoutAnswer(req, url, candidates, fields);
    if (!post && typeof fields.oauth_token === 'string' && candidates.some((item) => item.protocol === 'oauth1'))
      return twitterAnswer(req, candidates, fields);
    const codeGrant = candidates.some((item) => item.type === 'oauth2' && item.protocol !== 'oauth1');
    if (
      !post &&
      codeGrant &&
      typeof fields.state === 'string' &&
      !fields.state.startsWith('OpenIdConnect.') &&
      (fields.code || fields.error)
    )
      return authorizationCodeAnswer(req, candidates, fields);
    return null;
  }

  return { challenge, signOut, answer };
}
