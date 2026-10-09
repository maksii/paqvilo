import http from "node:http";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from "node:crypto";

/**
 * Local identity provider for the portal's external sign-in (docs/sim-administration.md,
 * "External sign-in"). Each runtime starts one on its own loopback port, cross-origin to
 * the portal like an online provider. Per configured provider it serves, under the
 * provider's local authority http://<host>:<port>/<slug>/, the endpoints the portal uses
 * on reference-portal (capture: docs/runtime-evidence.md): the OpenID
 * Connect discovery document, its signing keys, oauth2/authorize and oauth2/logout; and,
 * for the authorization code flow (Learn, "Set up an OpenID Connect provider"),
 * oauth2/token (client_secret_post or private_key_jwt, with PKCE) and openid/userinfo.
 *
 * The authorize page lists the local preset users (active local contacts) and a "New user"
 * form for first-time registration. Its answer follows the response type: an RS256 id_token,
 * an authorization code and an access token as requested, posted back with
 * response_mode=form_post or appended to the redirect URI with response_mode=query.
 * prompt=none answers without a page (login_hint or the provider's session) or with
 * login_required; prompt=login, select_account, consent and create always show the page.
 * acr_values come back as the id_token's acr claim. Its pages are plainly a local simulation
 * and never imitate an online provider's sign-in screen.
 */

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const base64url = (value) => Buffer.from(value).toString("base64url");
const leftHash = (value) => createHash("sha256").update(value).digest().subarray(0, 16).toString("base64url");
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TITLE = "Local identity provider (simulation)";
/** Protocol parameters of the authorize request; other parameters are the request's extras. */
const AUTHORIZE_FIELDS = ["client_id", "redirect_uri", "response_type", "scope", "state", "response_mode", "nonce", "ui_locales", "login_hint", "prompt", "acr_values", "code_challenge", "code_challenge_method"];
/** Fields of the chooser's own forms. */
const CHOOSER_FIELDS = new Set(["subject", "given_name", "family_name", "email", "phone_number"]);
/** Response types the provider answers; Power Pages does not support code token (Learn). */
const RESPONSE_TYPES = ["code", "id_token", "code id_token", "id_token token", "code id_token token"];
const PROMPTS = ["none", "login", "consent", "select_account", "create"];
const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const CODE_LIFETIME_MS = 5 * 60 * 1000;
const TOKEN_LIFETIME_S = 3600;
const LIMIT = 500;
const normalizeResponseType = (value) => String(value ?? "").trim().split(/\s+/).filter(Boolean).sort().join(" ");
const remember = (map, key, value) => {
  map.set(key, value);
  if (map.size > LIMIT) map.delete(map.keys().next().value);
};

function page(body, { autoSubmit = false } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${TITLE}</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f4f4f4;color:#222}main{max-width:680px;margin:32px auto;padding:20px 24px;background:#fff;border:2px dashed #8a6d3b;border-radius:6px}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:20px 0 4px}.note{color:#8a6d3b;font-size:13px;margin:0 0 12px}ul{list-style:none;padding:0;margin:0}li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-top:1px solid #eee}button{font:inherit;padding:5px 12px;cursor:pointer}label{display:block;margin:6px 0}input[type=text],input[type=email],input[type=tel]{width:100%;padding:5px;box-sizing:border-box}small{color:#666}code{font-size:12px}dl{margin:0;font-size:13px}dt{font-weight:600}dd{margin:0 0 4px}</style></head><body${autoSubmit ? ' onload="document.forms[0].submit()"' : ""}><main>${body}</main></body></html>`;
}

/** Display, given and family names of a preset user. */
function nameParts(user) {
  const name = String(user.name ?? "").trim();
  const given = String(user.givenName ?? "").trim() || (name.split(/\s+/)[0] ?? "");
  const family = String(user.familyName ?? "").trim() || name.split(/\s+/).slice(1).join(" ");
  return { name: name || [given, family].filter(Boolean).join(" ") || user.email || user.subject, given, family };
}

const normalizeHint = (value) => String(value ?? "").trim().toLowerCase().replace(/[{}]/g, "");

/** A compact JWT's header and claims, or null. */
function decodeJwt(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  try {
    return { parts, header: JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")), claims: JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) };
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
export async function startIdentityProvider({ host = "127.0.0.1", port = 0, providers, users, provision = async () => {}, allowRedirect = () => false }) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const kid = createHash("sha256").update(jwk.n).digest("base64url").slice(0, 16);
  let origin = null;
  let cookieName = "paqvilo-mirage-idp";
  const sessions = new Map();
  const codes = new Map();
  const accessTokens = new Map();
  const assertions = new Map();
  const authority = (provider) => `${origin}/${provider.slug}/`;
  const tokenEndpoint = (provider) => `${authority(provider)}oauth2/token`;
  const signToken = (payload) => {
    const header = base64url(JSON.stringify({ typ: "JWT", alg: "RS256", kid }));
    const body = base64url(JSON.stringify(payload));
    return `${header}.${body}.${sign("sha256", Buffer.from(`${header}.${body}`), privateKey).toString("base64url")}`;
  };
  const headers = (extra = {}) => ({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", ...extra });
  const respond = (res, status, html, extra = {}) => {
    res.writeHead(status, headers(extra));
    res.end(html);
  };
  const json = (res, status, value, extra = {}) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", "x-content-type-options": "nosniff", ...extra });
    res.end(JSON.stringify(value));
  };
  const fail = (res, status, message) =>
    respond(res, status, page(`<h1>${TITLE}</h1><p class="note">The request was rejected.</p><p role="alert" id="paqvilo-mirage-idp-error">${escapeHtml(message)}</p>`));
  /** A token endpoint error (RFC 6749 5.2); invalid_client answers 401. */
  const tokenError = (res, error, description) => json(res, error === "invalid_client" ? 401 : 400, { error, error_description: description });
  const readForm = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > 65536) {
          reject(Object.assign(new Error("The request body is too large."), { status: 413 }));
          req.destroy();
        } else chunks.push(chunk);
      });
      req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")))));
      req.on("error", reject);
    });
  const sessionCookie = (req) => {
    for (const part of String(req.headers.cookie ?? "").split(";")) {
      const index = part.indexOf("=");
      if (index > 0 && part.slice(0, index).trim() === cookieName) return part.slice(index + 1).trim();
    }
    return null;
  };
  const authorizeParams = (source) => Object.fromEntries(AUTHORIZE_FIELDS.map((key) => [key, String(source[key] ?? "")]));
  /** Non-protocol parameters of the request (custom authorization parameters), bounded. */
  const extrasOf = (source) =>
    Object.fromEntries(
      Object.entries(source)
        .filter(([key, value]) => !AUTHORIZE_FIELDS.includes(key) && !CHOOSER_FIELDS.has(key) && /^[A-Za-z0-9_.-]{1,64}$/.test(key) && typeof value === "string" && value.length <= 1000)
        .slice(0, 20),
    );
  /** Like an online provider: an unknown client or unregistered reply URL is never redirected to. */
  const validateAuthorize = (provider, params) => {
    if (params.client_id !== provider.clientId) return `The client_id "${params.client_id}" is not registered for this provider (expected "${provider.clientId}").`;
    if (params.redirect_uri !== provider.redirectUri) return `The redirect_uri "${params.redirect_uri}" is not the provider's registered reply URL (${provider.redirectUri}).`;
    const type = normalizeResponseType(params.response_type);
    if (!RESPONSE_TYPES.map(normalizeResponseType).includes(type)) return `response_type "${params.response_type}" is not supported (supported: ${RESPONSE_TYPES.join(", ")}).`;
    if (!["form_post", "query"].includes(params.response_mode)) return "response_mode must be form_post or query.";
    if (!/(?:^|\s)openid(?:\s|$)/.test(params.scope)) return "scope must include openid.";
    // A nonce is required wherever the id_token comes from this endpoint (implicit and hybrid).
    if (!params.state || (/\bid_token\b/.test(type) && !params.nonce)) return "state and nonce are required.";
    const prompts = params.prompt.split(/\s+/).filter(Boolean);
    if (prompts.some((value) => !PROMPTS.includes(value))) return `prompt "${params.prompt}" is not supported (supported: ${PROMPTS.join(", ")}).`;
    if (prompts.includes("none") && prompts.length > 1) return "prompt=none cannot be combined with another prompt value.";
    if (params.code_challenge && !/^[A-Za-z0-9._~-]{43,128}$/.test(params.code_challenge)) return "code_challenge must be 43 to 128 unreserved characters.";
    if (params.code_challenge_method && (!params.code_challenge || !["S256", "plain"].includes(params.code_challenge_method))) return "code_challenge_method must be S256 or plain, with a code_challenge.";
    return null;
  };
  /** Sends `fields` to the redirect URI: an auto-submitting form_post page or a query redirect. */
  const deliver = (res, params, fields, extra = {}) => {
    if (params.response_mode === "query") {
      const target = new URL(params.redirect_uri);
      for (const [key, value] of Object.entries(fields)) target.searchParams.set(key, value);
      res.writeHead(302, { location: target.href, "cache-control": "no-store", ...extra });
      return res.end();
    }
    const inputs = Object.entries(fields)
      .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
      .join("");
    return respond(res, 200, page(`<form method="post" action="${escapeHtml(params.redirect_uri)}">${inputs}<h1>${TITLE}</h1><p class="note">Returning to the portal…</p><noscript><button type="submit">Continue</button></noscript></form>`, { autoSubmit: true }), extra);
  };
  /** An authorization error response (OpenID Connect Core 3.1.2.6), such as login_required. */
  const deny = (res, params, error, description) => deliver(res, params, { error, error_description: description, state: params.state });
  /** Claims of `user` in an id_token for `params` (nonce, acr) and the hashes of the codes/tokens it accompanies. */
  const idTokenClaims = (provider, params, user, { code = null, accessToken = null } = {}) => {
    const { name, given, family } = nameParts(user);
    const now = Math.floor(Date.now() / 1000);
    const acr = params.acr_values.split(/\s+/).filter(Boolean)[0];
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
    const token = randomBytes(32).toString("base64url");
    remember(accessTokens, token, { slug: provider.slug, clientId: params.client_id, user, scope: params.scope, expires: Date.now() + TOKEN_LIFETIME_S * 1000 });
    return token;
  };
  /** The authorization response for `user`, as the response type asks. */
  const answer = (res, provider, params, user) => {
    const type = normalizeResponseType(params.response_type).split(" ");
    const code = type.includes("code") ? randomBytes(24).toString("base64url") : null;
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
        method: params.code_challenge ? params.code_challenge_method || "plain" : null,
        expires: Date.now() + CODE_LIFETIME_MS,
      });
    const accessToken = type.includes("token") ? issueAccessToken(provider, params, user) : null;
    const fields = {
      ...(code ? { code } : {}),
      ...(accessToken ? { access_token: accessToken, token_type: "Bearer", expires_in: String(TOKEN_LIFETIME_S) } : {}),
      ...(type.includes("id_token") ? { id_token: signToken(idTokenClaims(provider, params, user, { code, accessToken })) } : {}),
      state: params.state,
    };
    const session = randomBytes(18).toString("base64url");
    remember(sessions, session, { subject: user.subject, provider: provider.slug, user, at: Date.now() });
    return deliver(res, params, fields, { "set-cookie": `${cookieName}=${session}; Path=/; HttpOnly; SameSite=Lax` });
  };
  const chooser = (provider, params, extras, list) => {
    const hidden = Object.entries({ ...extras, ...params })
      .filter(([, value]) => value)
      .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
      .join("");
    const action = `/${escapeHtml(provider.slug)}/oauth2/authorize`;
    const prompts = params.prompt.split(/\s+/).filter(Boolean);
    const rows = list
      .map((user) => {
        const { name } = nameParts(user);
        return `<li class="paqvilo-mirage-idp-user" data-subject="${escapeHtml(user.subject)}" data-contact-id="${escapeHtml(user.contactId ?? "")}"><span><strong>${escapeHtml(name)}</strong>${user.email ? ` <small>${escapeHtml(user.email)}</small>` : ""}${user.description ? `<br><small>${escapeHtml(user.description)}</small>` : ""}</span><form method="post" action="${action}">${hidden}<input type="hidden" name="subject" value="${escapeHtml(user.subject)}"><button type="submit">Continue as ${escapeHtml(name)}</button></form></li>`;
      })
      .join("");
    const requester = (() => {
      try {
        return new URL(params.redirect_uri).origin;
      } catch {
        return params.redirect_uri;
      }
    })();
    // What the request asked for beyond the user: prompt, authentication context and custom parameters.
    const requested = [
      prompts.length ? `<dt>prompt</dt><dd id="paqvilo-mirage-idp-prompt">${escapeHtml(prompts.join(" "))}</dd>` : "",
      params.acr_values ? `<dt>acr_values</dt><dd id="paqvilo-mirage-idp-acr">${escapeHtml(params.acr_values)} <small>(the answer's acr claim; no step-up is simulated)</small></dd>` : "",
      prompts.includes("consent") ? `<dt>consent</dt><dd>The portal asks for consent to the scope ${escapeHtml(params.scope)}.</dd>` : "",
      ...Object.entries(extras).map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd class="paqvilo-mirage-idp-extra" data-name="${escapeHtml(key)}">${escapeHtml(value)}</dd>`),
    ].join("");
    const presets = `<h2>Preset users</h2>` + (list.length ? `<ul aria-label="Preset users">${rows}</ul>` : "<p>No preset users: the local data has no active contacts.</p>");
    const create = `<h2>New user</h2><p><small>Signs in with a new external identity, to exercise the portal's first-time registration.</small></p><form method="post" action="${action}" class="paqvilo-mirage-idp-new-user" id="paqvilo-mirage-idp-create">${hidden}<input type="hidden" name="subject" value="new"><label>Given name <input type="text" name="given_name" required maxlength="100"></label><label>Family name <input type="text" name="family_name" required maxlength="100"></label><label>Email <input type="email" name="email" required maxlength="200"></label><label>Phone (optional, a UserInfo claim) <input type="tel" name="phone_number" maxlength="50"></label><button type="submit">Continue as a new user</button></form>`;
    return page(
      `<h1>${TITLE}</h1><p class="note">Signing in to ${escapeHtml(requester)} with ${escapeHtml(provider.caption && provider.caption !== provider.key ? `${provider.caption} (${provider.key})` : provider.key)} · local simulation, no credentials are used</p>` +
        (requested ? `<h2>Request</h2><dl aria-label="Request">${requested}</dl>` : "") +
        // prompt=create (OpenID Connect Prompt Create) puts the sign-up form first.
        (prompts.includes("create") ? create + presets : presets + create),
    );
  };
  const presetUsers = async (provider) => (await users(provider)) ?? [];
  const hinted = (list, hint) => {
    const value = normalizeHint(hint);
    if (!value) return null;
    return list.find((user) => [user.contactId, user.subject, user.email, ...(user.hints ?? [])].some((candidate) => normalizeHint(candidate) === value)) ?? null;
  };
  /** The provider's signed-in user in this browser (its session cookie), for prompt=none. */
  const sessionUser = (req, provider) => {
    const entry = sessions.get(sessionCookie(req) ?? "");
    return entry && entry.provider === provider.slug ? entry.user : null;
  };

  // ---- token endpoint: client authentication and the code grant ----
  /** The client's authentication at the token endpoint, as the provider registration expects; an error message or null. */
  function authenticateClient(provider, form) {
    const method = provider.tokenAuthMethod === "private_key_jwt" ? "private_key_jwt" : "client_secret_post";
    if (method === "client_secret_post") {
      if (form.client_assertion) return "This client is registered for client_secret_post, not a client assertion.";
      if (form.client_id !== provider.clientId) return `The client_id "${form.client_id ?? ""}" is not registered for this provider.`;
      if (!provider.clientSecret) return "No client secret is registered for this client: set the provider's ClientSecret site setting.";
      if (form.client_secret !== provider.clientSecret) return "The client secret is wrong.";
      return null;
    }
    if (form.client_assertion_type !== CLIENT_ASSERTION_TYPE || !form.client_assertion) return `This client is registered for private_key_jwt: send a client_assertion of type ${CLIENT_ASSERTION_TYPE}.`;
    const jwt = decodeJwt(form.client_assertion);
    if (!jwt) return "The client assertion is not a JSON Web Token.";
    const key = (provider.clientKeys ?? []).find((item) => item.kid === jwt.header.kid);
    if (jwt.header.alg !== "RS256" || !key) return `The client assertion is not signed with a registered key (kid "${jwt.header.kid ?? ""}").`;
    let signed = false;
    try {
      signed = verify("sha256", Buffer.from(`${jwt.parts[0]}.${jwt.parts[1]}`), createPublicKey({ key, format: "jwk" }), Buffer.from(jwt.parts[2], "base64url"));
    } catch {
      signed = false;
    }
    if (!signed) return "The client assertion signature is invalid.";
    const { iss, sub, aud, exp, jti } = jwt.claims;
    if (iss !== provider.clientId || sub !== provider.clientId) return "The client assertion's iss and sub must be the client_id.";
    if (form.client_id && form.client_id !== provider.clientId) return "The client_id does not match the client assertion.";
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(tokenEndpoint(provider)) && !audiences.includes(authority(provider))) return "The client assertion's audience is not this token endpoint.";
    const now = Date.now() / 1000;
    if (!(Number(exp) > now - 60)) return "The client assertion has expired.";
    if (typeof jti !== "string" || !jti) return "The client assertion has no jti.";
    if (assertions.has(`${provider.slug}|${jti}`)) return "The client assertion was already used (jti replay).";
    remember(assertions, `${provider.slug}|${jti}`, Date.now());
    return null;
  }
  /** PKCE (RFC 7636): the code_verifier for the code's challenge; an error message or null. */
  function verifyPkce(entry, verifier) {
    if (!entry.challenge) return null;
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(String(verifier ?? ""))) return "The code_verifier is missing or malformed (PKCE).";
    const derived = entry.method === "S256" ? createHash("sha256").update(verifier).digest("base64url") : verifier;
    return derived === entry.challenge ? null : "The code_verifier does not match the code_challenge (PKCE).";
  }
  async function token(req, res, provider) {
    const form = await readForm(req);
    if (form.grant_type !== "authorization_code") return tokenError(res, "unsupported_grant_type", `grant_type "${form.grant_type ?? ""}" is not supported; this provider redeems authorization codes.`);
    const clientProblem = authenticateClient(provider, form);
    if (clientProblem) return tokenError(res, "invalid_client", clientProblem);
    const entry = codes.get(String(form.code ?? ""));
    if (!entry || entry.slug !== provider.slug) return tokenError(res, "invalid_grant", "The authorization code is unknown.");
    codes.delete(String(form.code));
    if (entry.used || Date.now() > entry.expires) return tokenError(res, "invalid_grant", "The authorization code has expired or was already redeemed.");
    if (form.redirect_uri !== entry.redirectUri) return tokenError(res, "invalid_grant", "The redirect_uri is not the one the code was issued for.");
    if (entry.clientId !== provider.clientId) return tokenError(res, "invalid_grant", "The code was issued to another client.");
    const pkce = verifyPkce(entry, form.code_verifier);
    if (pkce) return tokenError(res, "invalid_grant", pkce);
    const params = { client_id: entry.clientId, nonce: entry.nonce ?? "", acr_values: entry.acr ?? "", scope: entry.scope };
    const accessToken = issueAccessToken(provider, params, entry.user);
    return json(res, 200, {
      token_type: "Bearer",
      access_token: accessToken,
      expires_in: TOKEN_LIFETIME_S,
      scope: entry.scope,
      id_token: signToken(idTokenClaims(provider, params, entry.user, { accessToken })),
    });
  }
  function userinfo(req, res, provider) {
    const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
    const entry = bearer ? accessTokens.get(bearer) : null;
    if (!entry || entry.slug !== provider.slug || Date.now() > entry.expires)
      return json(res, 401, { error: "invalid_token", error_description: bearer ? "The access token is unknown or expired." : "A Bearer access token is required." }, { "www-authenticate": `Bearer error="invalid_token"` });
    return json(res, 200, userInfoClaims(entry.user));
  }

  async function handle(req, res) {
    const url = new URL(req.url, origin);
    if (req.method === "GET" && url.pathname === "/") {
      const items = providers()
        .map((provider) => `<li><span><strong>${escapeHtml(provider.caption ?? provider.key)}</strong> <small>${escapeHtml(provider.key)}</small><br><code>${escapeHtml(authority(provider))}</code></span><a href="/${escapeHtml(provider.slug)}/.well-known/openid-configuration">Discovery document</a></li>`)
        .join("");
      return respond(res, 200, page(`<h1>${TITLE}</h1><p class="note">Serves the portal's external sign-in on this machine only.</p><ul aria-label="Providers">${items || "<li>No external identity provider is configured in the site settings.</li>"}</ul>`));
    }
    const [, slug, ...rest] = url.pathname.split("/");
    const route = rest.join("/");
    const provider = SLUG.test(slug ?? "") ? providers().find((item) => item.slug === slug) ?? null : null;
    if (!provider) return fail(res, 404, "Unknown provider.");
    if (req.method === "GET" && route === ".well-known/openid-configuration")
      return json(res, 200, {
        issuer: authority(provider),
        authorization_endpoint: `${authority(provider)}oauth2/authorize`,
        token_endpoint: tokenEndpoint(provider),
        userinfo_endpoint: `${authority(provider)}openid/userinfo`,
        end_session_endpoint: `${authority(provider)}oauth2/logout`,
        jwks_uri: `${authority(provider)}discovery/keys`,
        response_types_supported: RESPONSE_TYPES,
        response_modes_supported: ["form_post", "query"],
        grant_types_supported: ["authorization_code", "implicit"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "private_key_jwt"],
        token_endpoint_auth_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256", "plain"],
        prompt_values_supported: PROMPTS,
        scopes_supported: ["openid", "profile", "email", "phone"],
        claims_supported: ["aud", "iss", "iat", "nbf", "exp", "acr", "at_hash", "c_hash", "email", "email_verified", "preferred_username", "family_name", "given_name", "name", "nonce", "oid", "phone_number", "sub"],
      });
    if (req.method === "GET" && route === "discovery/keys") return json(res, 200, { keys: [{ kty: jwk.kty, use: "sig", kid, alg: "RS256", n: jwk.n, e: jwk.e }] });
    if (req.method === "POST" && route === "oauth2/token") return token(req, res, provider);
    if (["GET", "POST"].includes(req.method) && route === "openid/userinfo") return userinfo(req, res, provider);
    if (route === "oauth2/authorize" && ["GET", "POST"].includes(req.method)) {
      const form = req.method === "POST" ? await readForm(req) : Object.fromEntries(url.searchParams);
      const params = authorizeParams(form);
      const extras = extrasOf(form);
      const problem = validateAuthorize(provider, params);
      if (problem) return fail(res, 400, problem);
      const list = await presetUsers(provider);
      if (req.method === "GET") {
        const prompts = params.prompt.split(/\s+/).filter(Boolean);
        if (prompts.includes("none")) {
          // No page: the hinted user or this browser's provider session, else login_required.
          const silent = hinted(list, params.login_hint) ?? sessionUser(req, provider);
          if (!silent) return deny(res, params, "login_required", "prompt=none: no user is signed in to the local identity provider in this browser and login_hint names no preset user.");
          if (silent.contactId) await provision(provider, silent);
          return answer(res, provider, params, silent);
        }
        const match = prompts.length ? null : hinted(list, params.login_hint);
        if (!match) return respond(res, 200, chooser(provider, params, extras, list));
        await provision(provider, match);
        return answer(res, provider, params, match);
      }
      if (form.subject === "new") {
        const email = String(form.email ?? "").trim();
        const given = String(form.given_name ?? "").trim();
        const family = String(form.family_name ?? "").trim();
        const phone = String(form.phone_number ?? "").trim();
        if (!email.includes("@") || !given || !family || email.length > 200 || given.length > 100 || family.length > 100 || phone.length > 50)
          return fail(res, 400, "A new user needs a given name, a family name and an email address.");
        return answer(res, provider, params, { subject: randomUUID(), email, givenName: given, familyName: family, name: `${given} ${family}`, ...(phone ? { phone } : {}) });
      }
      const user = list.find((item) => item.subject === form.subject);
      if (!user) return fail(res, 400, "Choose one of the preset users.");
      await provision(provider, user);
      return answer(res, provider, params, user);
    }
    if (req.method === "GET" && route === "oauth2/logout") {
      const current = sessionCookie(req);
      if (current) sessions.delete(current);
      const cleared = { "set-cookie": `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` };
      const target = url.searchParams.get("post_logout_redirect_uri");
      if (target && allowRedirect(target)) {
        const next = new URL(target);
        const state = url.searchParams.get("state");
        if (state) next.searchParams.set("state", state);
        res.writeHead(302, { ...cleared, location: next.href, "cache-control": "no-store" });
        return res.end();
      }
      return respond(
        res,
        200,
        page(`<h1>${TITLE}</h1><p class="note">Signed out of the local identity provider.</p>${target ? `<p role="alert">The post_logout_redirect_uri is not on the portal's origin and was not followed.</p>` : ""}`),
        cleared,
      );
    }
    return fail(res, 404, "Unknown identity provider endpoint.");
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) fail(res, error.status ?? 500, error.message);
      else res.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, resolve);
  });
  origin = `http://${host === "::1" ? "[::1]" : host}:${server.address().port}`;
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
