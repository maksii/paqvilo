import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { startIdentityProvider } from "./identity-provider.mjs";
import {
  authenticationSettings,
  contactFieldsFromClaims,
  emailClaim,
  externalProviders,
  isMicrosoftAuthority,
  loginButtonProvider,
  presetSubject,
  PROMPT_VALUES,
  resolveProvider,
} from "./external-login.mjs";
import { authRoute, parseCookies, returnUrlParameter, safeReturnUrl } from "./auth-session.mjs";
import { loginPath } from "./redirects.mjs";

/**
 * The portal side of external sign-in (docs/sim-administration.md, "External sign-in").
 *
 * reference-portal (capture: docs/runtime-evidence.md): the portal's
 * provider form POSTs /Account/Login/ExternalLogin?returnUrl=... with
 * __RequestVerificationToken and provider = the provider's AuthenticationType (for
 * Microsoft Entra, its authority); the portal answers 302 to <authority>oauth2/authorize
 * with client_id, redirect_uri (the site root), response_type "code id_token", scope
 * "openid profile", state, response_mode form_post, nonce and ui_locales, and sets an
 * OpenIdConnect.nonce.<value> cookie. An anonymous GET /Account/Login/LogOff answers 302
 * to <LoginPath>?ReturnUrl=%2FAccount%2FLogin%2FLogOff.
 *
 * Locally the provider's authority is its local authority on the runtime's identity
 * provider (lib/identity-provider.mjs). The response handling that reference-portal could not show
 * without an interactive sign-in follows the documented ASP.NET Identity/OWIN external
 * login pattern the platform is built on (Learn, "Local authentication, registration, and
 * other settings"): the provider's form post to the reply URL is validated (state, id_token
 * signature from the provider's keys, issuer, audience, lifetime, nonce and the nonce
 * cookie), kept in a short-lived external sign-in cookie and redirected to
 * /Account/Login/ExternalLoginCallback, which maps the identity to a contact through
 * adx_externalidentity (identity provider name + username = subject), applies contact
 * mapping with email and the registration and invitation settings, starts the session
 * and returns to the return URL.
 *
 * Flows (Learn, "Set up an OpenID Connect provider"): the hybrid flow (code id_token, the
 * default, used by the built-in Microsoft Entra provider) and the implicit flow sign in with the
 * front-channel id_token. The authorization code flow (ResponseType code, ResponseMode query)
 * redeems the code at the provider's token endpoint with client_secret_post (ClientSecret) or
 * private_key_jwt (TokenEndPointAuthenticatedMethod, PrivateKeyJwt/CertificateObject) and signs
 * in with the token response's id_token. It sends PKCE (S256), as the OWIN OpenID Connect
 * middleware the platform builds on does for the code flow (UsePkce, Katana 4.1); the platform's
 * own request was not observed. With UseUserInfoEndpointforClaims the access token reads the
 * UserInfo endpoint for userinfo.<claim> mappings; every UserInfo problem is a warning and
 * sign-in continues (Learn). Prompt, AcrValues and the ExternalLogin request's prompt,
 * login_hint and AllowedDynamicAuthorizationParameters reach the authorize request. The token
 * and UserInfo requests go to the local identity provider only; a UserInfoEndpoint setting on
 * loopback is used as configured, an online one is answered by the local provider's endpoint.
 */

const NONCE_COOKIE = "OpenIdConnect.nonce.";
const STATE_PREFIX = "OpenIdConnect.AuthenticationProperties=";
const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
// Parameters of the authorize request that no ExternalLogin request parameter can set.
const RESERVED_PARAMETERS = new Set(["client_id", "redirect_uri", "response_type", "scope", "state", "response_mode", "nonce", "ui_locales", "code_challenge", "code_challenge_method", "acr_values", "prompt", "login_hint", "provider", "returnurl", "invitationcode", "__requestverificationtoken"]);
/** Whether a provider uses the authorization code flow (ResponseType code): the code is redeemed. */
const codeFlow = (provider) => String(provider.responseType ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ") === "code";
const flowOf = (provider) => {
  const parts = String(provider.responseType ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  return codeFlow(provider) ? "authorization-code" : parts.includes("code") ? "hybrid" : "implicit";
};
const loopbackUrl = (value) => {
  try {
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
};
/** Text and boolean claims a cookie can carry. */
const keptClaims = (claims, skip = [], limit = 30) =>
  Object.fromEntries(
    Object.entries(claims ?? {})
      .filter(([name, value]) => !skip.includes(name) && ["string", "boolean"].includes(typeof value) && String(value).length <= 256)
      .slice(0, limit),
  );
// ASP.NET Identity's external sign-in cookie lives five minutes.
const EXTERNAL_LIFETIME_MS = 5 * 60 * 1000;
const IDENTITY_TABLE = "adx_externalidentity";
const INVITATION_TABLE = "adx_invitation";
// adx_invitation (Dataverse reference): adx_type Single 756150000 / Group 756150001;
// statuscode Redeemed 756150001.
const INVITATION_SINGLE = 756150000;
const INVITATION_GROUP = 756150001;
const INVITATION_REDEEMED = 756150001;
const LEDGER_LIMIT = 200;
const WEB_ROLE_TABLES = new Set(["adx_webrole", "mspp_webrole", "powerpagecomponent"]);

const text = (value) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
};
const key = (value) => String(value ?? "").replace(/[{}]/g, "").trim().toLowerCase();
const same = (a, b) => key(a) !== "" && key(a) === key(b);
const scalar = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value.value ?? value.id ?? null : value);
const lookupId = (value) => key(value && typeof value === "object" ? value.id ?? value.value : value);
// A lookup column as local rows hold it: { id, logical_name } under its name, or the Web API _<name>_value.
const lookupOf = (row, name) => lookupId(row?.[name] ?? row?.[`_${name}_value`]);
const active = (row) => Number(scalar(row?.statecode) ?? 0) === 0;
const trimPath = (value) => String(value ?? "").replace(/\/+$/, "").toLowerCase() || "/";
const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

class SignInProblem extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Create the external sign-in flow of one runtime.
 * - portal(), origin(): the current portal model and the runtime's origin.
 * - csrf: the anti-forgery token /_layout/tokenhtml hands out.
 * - sessions: lib/auth-session.mjs createAuthSessions().
 * - store: the DataStore; personas(): active local personas; webRoles(): exported web roles.
 * - identity(): the request's effective identity; audit/trace: the runtime's audit log.
 * - diagnostic(d): records a runtime diagnostic.
 * - renderSignIn(req, res, url, { status, returnUrl, error, invitationCode }) and
 *   renderPage(req, res, url, { status, title, content, route }): pages in the site shell.
 * - readBody(req): the request body (Buffer).
 */
export function createExternalSignIn({ portal, origin, csrf, sessions, store, personas, webRoles = () => [], identity, audit, trace, diagnostic = () => {}, renderSignIn, renderPage, readBody }) {
  let idp = null;
  // Protected data (the state's authentication properties and the external sign-in cookie) is
  // encrypted and authenticated (AES-256-GCM), as the platform's data protection does: the PKCE
  // verifier in the state never shows in a URL. Keys are created for each process.
  const encryptionKey = randomBytes(32);
  const macKey = randomBytes(32);
  const mac = (value) => createHmac("sha256", macKey).update(value).digest("base64url");
  const protect = (data) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
  };
  const unprotect = (value) => {
    try {
      const raw = Buffer.from(String(value ?? ""), "base64url");
      if (raw.length < 29) return null;
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      const data = JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8"));
      return data && typeof data === "object" ? data : null;
    } catch {
      return null;
    }
  };
  // The local stand-in for the site's custom certificate (private_key_jwt): its public key is
  // registered with the local identity provider under the configured thumbprint (kid).
  let clientKeys = null;
  const clientKeyPair = () => (clientKeys ??= generateKeyPairSync("rsa", { modulusLength: 2048 }));
  const port = () => new URL(origin()).port;
  const externalCookieName = () => `paqvilo-mirage-external-${port()}`;
  const nonceCookieName = (nonce) => NONCE_COOKIE + mac(`nonce:${nonce}`);
  // Providers per portal model (a reload or override replaces the model).
  const providerCache = new WeakMap();
  const providerList = () => {
    const current = portal();
    if (!providerCache.has(current)) providerCache.set(current, externalProviders(current));
    return providerCache.get(current);
  };
  const redirectUri = (provider) => new URL(provider.callbackPath, origin()).href;
  const settings = () => authenticationSettings(portal());

  // ---- data: contacts, external identities, invitations, ledger ----
  const contactMapping = () => {
    try {
      return store.resolveMapping("contact");
    } catch {
      return null;
    }
  };
  const tableRows = (logical) => store.state.tables?.[logical] ?? [];
  const contactRows = () => {
    const mapping = contactMapping();
    return mapping ? tableRows(mapping.logicalName).map((row) => ({ row, id: key(row[mapping.idColumn]) })) : [];
  };
  const contactById = (contactId) => contactRows().find((item) => item.id === key(contactId))?.row ?? null;
  const contactName = (row) => (row ? String(row.fullname ?? [row.firstname, row.lastname].filter(Boolean).join(" ")).trim() || null : null);
  const identityRows = () => tableRows(IDENTITY_TABLE);
  /**
   * Identity rows of a provider: its AuthenticationType. A built-in provider on the default
   * multi-tenant authority (the site's tenant is unknown locally) also matches rows that
   * name a tenant authority.
   */
  const providerMatches = (provider, name) =>
    same(name, provider.id) || (provider.builtIn && provider.authoritySource === "default" && isMicrosoftAuthority(name));
  const findIdentity = (provider, subject) =>
    identityRows().find((row) => active(row) && providerMatches(provider, row.adx_identityprovidername) && same(row.adx_username, subject)) ?? null;
  const ledger = () => (Array.isArray(store.state.simulator?.signInRegistrations) ? store.state.simulator.signInRegistrations : []);
  /** An audit entry for a record the sign-in flow created (registration, identities). */
  const record = (kind, entity, query, contactId, { method, path } = {}) => {
    const context = trace.getStore();
    audit
      .begin({ kind, method: method ?? context?.method ?? "GET", path: path ?? context?.path ?? "/Account/Login/ExternalLoginCallback", entity, identity: { contactId }, query, correlationId: context?.correlationId, parentId: context?.spanId })
      .finish({ status: 201, rowCount: 1 });
  };
  /** The documented adx_externalidentity table (Dataverse reference), when the data does not define it. */
  const ensureIdentityTable = () => {
    const mappings = (store.state.mappings ??= {});
    const contact = contactMapping();
    if (!mappings[IDENTITY_TABLE])
      mappings[IDENTITY_TABLE] = {
        entitySet: "adx_externalidentities",
        entitySetSource: "dataverse-reference",
        idColumn: "adx_externalidentityid",
        idColumnSource: "dataverse-reference",
        nameColumn: "adx_username",
        relationships: {
          adx_contactid: { entity: "contact", from: "adx_contactid", to: contact?.idColumn ?? "contactid", many: false, schemaName: "adx_contact_externalidentity", type: "many-to-one", partner: "adx_contact_externalidentity" },
        },
        inferred: true,
      };
    (store.state.tables ??= {})[IDENTITY_TABLE] ??= [];
    return store.resolveMapping(IDENTITY_TABLE);
  };
  const addLedger = (entry) => {
    const simulator = (store.state.simulator ??= {});
    simulator.signInRegistrations = [...ledger(), { at: new Date().toISOString(), ...entry }].slice(-LEDGER_LIMIT);
  };
  /** Inside a transaction: an adx_externalidentity row linking the subject to the contact. */
  const createIdentityRow = (provider, subject, contactId, kind, extra = {}) => {
    const mapping = ensureIdentityTable();
    const contact = contactById(contactId);
    const row = store.createRecord(
      IDENTITY_TABLE,
      {
        [mapping.idColumn]: randomUUID(),
        adx_username: subject,
        adx_identityprovidername: provider.id,
        adx_contactid: { id: key(contactId), logical_name: "contact", name: contactName(contact) ?? "" },
        statecode: 0,
        statuscode: 1,
      },
      { admin: true },
    );
    addLedger({ kind, contactId: key(contactId), externalIdentityId: row[mapping.idColumn], provider: provider.id, username: subject, ...extra });
    return row[mapping.idColumn];
  };
  /** Inside a transaction: a contact created from claims (registration). */
  const createContactRow = (provider, claims, userinfo = null) => {
    const mapping = contactMapping();
    if (!mapping) throw new SignInProblem("The local data has no contact table, so registration cannot create a contact.", "REGISTRATION_CONTACT_UNMAPPED", 409);
    const fields = contactFieldsFromClaims(claims, provider.registrationClaims, { userinfo });
    const email = fields.emailaddress1 ?? emailClaim(claims);
    if (!fields.lastname) fields.lastname = String(claims.family_name ?? claims.name ?? email ?? claims.sub).trim();
    const contactId = randomUUID();
    store.createRecord(
      mapping.logicalName,
      { [mapping.idColumn]: contactId, ...fields, fullname: [fields.firstname, fields.lastname].filter(Boolean).join(" ") },
      { admin: true },
    );
    return contactId;
  };

  // ---- the identity provider ----
  const presetUsers = (provider) => {
    const contacts = new Map(contactRows().map((item) => [item.id, item.row]));
    const identities = identityRows().filter((row) => active(row) && providerMatches(provider, row.adx_identityprovidername));
    return personas().map((persona) => {
      const contact = contacts.get(key(persona.contactId));
      const existing = identities.find((row) => lookupOf(row, "adx_contactid") === key(persona.contactId));
      const roles = (persona.roles ?? []).length ? persona.roles.join(", ") : "no web roles";
      return {
        contactId: persona.contactId,
        subject: existing?.adx_username ?? presetSubject(provider, persona.contactId),
        name: persona.name ?? contactName(contact) ?? persona.contactId,
        givenName: contact?.firstname ?? null,
        familyName: contact?.lastname ?? null,
        email: contact?.emailaddress1 ?? null,
        phone: contact?.telephone1 ?? contact?.mobilephone ?? null,
        description: `${roles}${existing ? "" : " · identity recorded on first sign-in"}`,
      };
    });
  };
  /** A preset user's identity at the provider, recorded when the local data has none. */
  const provision = async (provider, user) => {
    if (!user.contactId || findIdentity(provider, user.subject)) return;
    const current = providerList().find((item) => item.slug === provider.slug);
    if (!current) return;
    await store.transact(() => {
      if (findIdentity(current, user.subject)) return;
      const externalIdentityId = createIdentityRow(current, user.subject, user.contactId, "preset");
      // Recorded by the local identity provider's preset selection, outside a portal request.
      record("external-identity", IDENTITY_TABLE, { provider: current.id, username: user.subject, contactId: key(user.contactId), externalIdentityId, origin: "preset" }, key(user.contactId), { method: "POST", path: `/${current.slug}/oauth2/authorize` });
    });
  };
  async function start({ host }) {
    idp = await startIdentityProvider({
      host,
      providers: () =>
        providerList().map((provider) => ({
          ...provider,
          redirectUri: redirectUri(provider),
          clientKeys: provider.tokenAuthMethod === "private_key_jwt" && provider.certificateKid ? [{ ...clientKeyPair().publicKey.export({ format: "jwk" }), kid: provider.certificateKid, alg: "RS256", use: "sig" }] : [],
        })),
      users: async (provider) => presetUsers(provider),
      provision,
      allowRedirect: (target) => {
        try {
          return new URL(target).origin === origin();
        } catch {
          return false;
        }
      },
    });
    // Provider settings that cannot be used as written (lib/external-login.mjs oidcOptions).
    for (const provider of providerList())
      for (const message of provider.problems ?? []) diagnostic({ code: "EXTERNAL_LOGIN_SETTING_INVALID", severity: "warning", provider: provider.key, message: `Authentication/OpenIdConnect/${provider.key}: ${message}` });
    return idp;
  }
  async function close() {
    const current = idp;
    idp = null;
    await current?.close();
  }

  // ---- provider metadata and token validation (as the platform reads its provider) ----
  const metadataCache = new Map();
  const getJson = async (target) => {
    const response = await fetch(target, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new SignInProblem(`The identity provider answered ${response.status} for ${target}.`, "EXTERNAL_LOGIN_METADATA_UNAVAILABLE", 502);
    return response.json();
  };
  async function metadata(provider, { refresh = false } = {}) {
    if (!idp) throw new SignInProblem("The local identity provider is not running.", "EXTERNAL_LOGIN_PROVIDER_UNAVAILABLE", 503);
    const authority = idp.authority(provider);
    const cached = metadataCache.get(provider.slug);
    if (!refresh && cached?.authority === authority) return cached;
    const config = await getJson(`${authority}.well-known/openid-configuration`);
    const jwks = await getJson(config.jwks_uri);
    const entry = { authority, config, keys: Array.isArray(jwks.keys) ? jwks.keys : [] };
    metadataCache.set(provider.slug, entry);
    return entry;
  }
  async function validateToken(provider, token) {
    const parts = String(token ?? "").split(".");
    if (parts.length !== 3) throw new SignInProblem("The id_token is not a JSON Web Token.", "EXTERNAL_LOGIN_TOKEN_INVALID");
    let header, claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      throw new SignInProblem("The id_token is malformed.", "EXTERNAL_LOGIN_TOKEN_INVALID");
    }
    let meta = await metadata(provider);
    let jwk = meta.keys.find((item) => item.kid === header.kid);
    if (!jwk) {
      meta = await metadata(provider, { refresh: true });
      jwk = meta.keys.find((item) => item.kid === header.kid);
    }
    if (header.alg !== "RS256" || !jwk) throw new SignInProblem("The id_token is not signed with a key of the provider.", "EXTERNAL_LOGIN_TOKEN_INVALID");
    const signed = verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url"));
    if (!signed) throw new SignInProblem("The id_token signature is invalid.", "EXTERNAL_LOGIN_TOKEN_INVALID");
    if (claims.iss !== meta.config.issuer) throw new SignInProblem("The id_token issuer is not the provider.", "EXTERNAL_LOGIN_TOKEN_INVALID");
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(provider.clientId)) throw new SignInProblem("The id_token audience is not the portal's client ID.", "EXTERNAL_LOGIN_TOKEN_INVALID");
    const now = Date.now() / 1000;
    if (!(Number(claims.exp) > now - 300) || (claims.nbf && Number(claims.nbf) > now + 300))
      throw new SignInProblem("The id_token is expired or not yet valid.", "EXTERNAL_LOGIN_TOKEN_INVALID");
    if (typeof claims.sub !== "string" || !claims.sub) throw new SignInProblem("The id_token has no subject.", "EXTERNAL_LOGIN_TOKEN_INVALID");
    if (typeof claims.nonce !== "string" || !claims.nonce) throw new SignInProblem("The id_token has no nonce.", "EXTERNAL_LOGIN_TOKEN_INVALID");
    return claims;
  }

  // ---- request helpers ----
  const formOf = (bytes) => Object.fromEntries(new URLSearchParams(bytes.toString("utf8")));
  const isForm = (req) => String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded");
  /** Hands an already read body to the next reader (all body readers iterate the request). */
  const replay = (req, bytes) => {
    req[Symbol.asyncIterator] = async function* () {
      if (bytes.length) yield bytes;
    };
  };
  const providerMessage = (fields) =>
    typeof fields.state === "string" && fields.state && (fields.id_token || fields.code || fields.error)
      ? { state: fields.state, id_token: fields.id_token ?? null, code: fields.code ?? null, access_token: fields.access_token ?? null, error: fields.error ?? null, error_description: fields.error_description ?? null }
      : null;
  const callbackPaths = () => new Set(providerList().map((provider) => trimPath(provider.callbackPath)));
  const noStore = { "cache-control": "no-cache, no-store" };
  const redirect = (res, location, route, cookies = []) => {
    res.writeHead(302, { location, ...noStore, ...(cookies.length ? { "set-cookie": cookies } : {}), "x-sim-route": route });
    return res.end();
  };
  const clearExternal = () => `${externalCookieName()}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  const readExternal = (req) => {
    const data = unprotect(parseCookies(req.headers.cookie)[externalCookieName()]);
    return data && Date.now() - Number(data.t) < EXTERNAL_LIFETIME_MS ? data : null;
  };
  const fail = (req, res, url, problem, { returnUrl = "/", invitationCode = null, cookies = [] } = {}) => {
    diagnostic({ code: problem.code, severity: "warning", message: problem.message, path: url.pathname });
    if (cookies.length) res.setHeader("set-cookie", cookies);
    return renderSignIn(req, res, url, { status: problem.status ?? 400, returnUrl, error: problem.message, invitationCode });
  };
  const ACCOUNT_PATH = /^\/account\/login\/(externallogin|externallogincallback|redeeminvitation|logoff)$/;
  const languageCode = (code) => code ?? (portal().websiteLanguages ?? []).find((language) => language.isDefault && language.code)?.code ?? null;

  // ---- ExternalLogin: the challenge ----
  async function challenge(res, provider, { returnUrl, invitationCode = null, loginHint = null, language = null, prompt = null, parameters = {} }) {
    const meta = await metadata(provider);
    const nonce = `${Date.now()}.${randomBytes(32).toString("base64url")}`;
    // PKCE for the code flow: the verifier travels in the protected state, as the OWIN
    // middleware keeps it in the authentication properties.
    const verifier = codeFlow(provider) ? randomBytes(32).toString("base64url") : null;
    const state = STATE_PREFIX + protect({ p: provider.slug, r: returnUrl, ...(invitationCode ? { i: invitationCode } : {}), ...(verifier ? { v: verifier } : {}), t: Date.now() });
    const params = new URLSearchParams({
      client_id: provider.clientId,
      redirect_uri: redirectUri(provider),
      response_type: provider.responseType,
      scope: provider.scope,
      state,
      response_mode: provider.responseMode,
      nonce,
    });
    if (language) params.set("ui_locales", language);
    // login_hint: an ExternalLogin request parameter (Learn); the toolkit panel posts it to
    // pick a preset user without a click.
    if (loginHint) params.set("login_hint", loginHint);
    // The Prompt site setting takes priority over the request's prompt parameter (Learn).
    const effectivePrompt = provider.prompt ?? prompt;
    if (effectivePrompt) params.set("prompt", effectivePrompt);
    if (provider.acrValues) params.set("acr_values", provider.acrValues);
    if (verifier) {
      params.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
      params.set("code_challenge_method", "S256");
    }
    for (const [name, value] of Object.entries(parameters)) params.set(name, value);
    const maxAge = Math.max(60, Math.round(provider.nonceLifetimeMs / 1000));
    return redirect(res, `${meta.config.authorization_endpoint}?${params}`, "external-login", [`${nonceCookieName(nonce)}=N; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`]);
  }
  async function externalLogin(req, res, url, { language }) {
    const bytes = await readBody(req);
    const form = isForm(req) || !req.headers["content-type"] ? formOf(bytes) : {};
    const returnUrl = safeReturnUrl(returnUrlParameter(url.searchParams) ?? form.ReturnUrl ?? form.returnUrl);
    const invitationCode = text(form.InvitationCode ?? form.invitationCode ?? url.searchParams.get("InvitationCode") ?? url.searchParams.get("invitationCode"));
    if (form.__RequestVerificationToken !== csrf)
      return fail(req, res, url, new SignInProblem("The anti-forgery token is missing or invalid: reload the page and sign in again.", "EXTERNAL_LOGIN_ANTIFORGERY_INVALID"), { returnUrl, invitationCode });
    if (!settings().externalLogin)
      return fail(req, res, url, new SignInProblem("External sign-in is turned off (Authentication/Registration/ExternalLoginEnabled is false).", "EXTERNAL_LOGIN_DISABLED"), { returnUrl });
    const providerName = form.provider ?? url.searchParams.get("provider");
    const provider = resolveProvider(providerList(), providerName);
    if (!provider)
      return fail(req, res, url, new SignInProblem(`The provider "${String(providerName ?? "")}" is not an identity provider of this site.`, "EXTERNAL_LOGIN_PROVIDER_UNKNOWN"), { returnUrl, invitationCode });
    return challenge(res, provider, { returnUrl, invitationCode, language: languageCode(language), ...dynamicParameters(provider, url, form) });
  }
  /**
   * The ExternalLogin request's authorization parameters (Learn, "Other authorization
   * parameters"): prompt and login_hint are always allowed (query string, or the form for the
   * toolkit panel); other query parameters only when AllowedDynamicAuthorizationParameters
   * lists them, never a protocol parameter. An unsupported prompt and unlisted parameters are
   * ignored, with an info diagnostic.
   */
  function dynamicParameters(provider, url, form) {
    const query = Object.fromEntries(url.searchParams);
    const prompt = text(query.prompt ?? form.prompt);
    const ignored = [];
    if (prompt && !PROMPT_VALUES.includes(prompt.toLowerCase())) ignored.push(`prompt=${prompt}`);
    const allowed = new Map(provider.dynamicParameters.map((name) => [name.toLowerCase(), name]));
    const parameters = {};
    for (const [name, value] of Object.entries(query)) {
      const lowered = name.toLowerCase();
      if (RESERVED_PARAMETERS.has(lowered)) continue;
      if (allowed.has(lowered) && value.length <= 1000) parameters[allowed.get(lowered)] = value;
      else ignored.push(name);
    }
    if (ignored.length)
      diagnostic({ code: "EXTERNAL_LOGIN_PARAMETER_IGNORED", severity: "info", message: `ExternalLogin ignored ${ignored.join(", ")}: prompt must be one of ${PROMPT_VALUES.join(", ")}, and other parameters need AllowedDynamicAuthorizationParameters.`, path: url.pathname });
    return { prompt: prompt && PROMPT_VALUES.includes(prompt.toLowerCase()) ? prompt.toLowerCase() : null, loginHint: text(query.login_hint ?? form.login_hint), parameters };
  }

  // ---- the code flow: redeeming the code, and UserInfo ----
  /** A private_key_jwt client assertion (RFC 7523) signed with the local stand-in for the site's certificate. */
  function clientAssertion(provider, audience) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: provider.certificateKid })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ iss: provider.clientId, sub: provider.clientId, aud: audience, jti: randomUUID(), iat: now, nbf: now, exp: now + 300 })).toString("base64url");
    return `${header}.${body}.${sign("sha256", Buffer.from(`${header}.${body}`), clientKeyPair().privateKey).toString("base64url")}`;
  }
  /** The token response for an authorization code (client_secret_post or private_key_jwt, PKCE). */
  async function redeemCode(provider, code, verifier) {
    const meta = await metadata(provider);
    const endpoint = meta.config.token_endpoint;
    if (!endpoint) throw new SignInProblem("The identity provider's metadata has no token_endpoint, so the authorization code cannot be redeemed.", "EXTERNAL_LOGIN_TOKEN_REQUEST_FAILED", 502);
    const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri(provider), client_id: provider.clientId });
    if (verifier) body.set("code_verifier", verifier);
    if (provider.tokenAuthMethod === "private_key_jwt") {
      if (!provider.certificateKid)
        throw new SignInProblem('TokenEndPointAuthenticatedMethod is private_key_jwt, but PrivateKeyJwt/CertificateObject names no certificate: set it to {"kid":"<thumbprint of the site\'s custom certificate>"}.', "EXTERNAL_LOGIN_CERTIFICATE_MISSING", 500);
      if (!(meta.config.token_endpoint_auth_methods_supported ?? []).includes("private_key_jwt"))
        throw new SignInProblem("The identity provider's metadata does not list private_key_jwt in token_endpoint_auth_methods_supported.", "EXTERNAL_LOGIN_AUTH_METHOD_UNSUPPORTED", 502);
      body.set("client_assertion_type", CLIENT_ASSERTION_TYPE);
      body.set("client_assertion", clientAssertion(provider, endpoint));
    } else body.set("client_secret", provider.clientSecret ?? "");
    let response;
    try {
      response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body, signal: AbortSignal.timeout(5000) });
    } catch (error) {
      throw new SignInProblem(`The identity provider's token endpoint is not reachable (${error.message}).`, "EXTERNAL_LOGIN_TOKEN_REQUEST_FAILED", 502);
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new SignInProblem(`The identity provider refused the authorization code (${result.error ?? response.status}${result.error_description ? `: ${result.error_description}` : ""}).`, "EXTERNAL_LOGIN_TOKEN_REQUEST_FAILED", 502);
    return result;
  }
  /** UserInfo claims (UseUserInfoEndpointforClaims), or null with a warning: sign-in continues (Learn). */
  async function userInfo(provider, accessToken, subject, url) {
    const warn = (code, message) => {
      diagnostic({ code, severity: "warning", message: `${message} Sign-in continues without UserInfo claims.`, path: url.pathname, provider: provider.key });
      return null;
    };
    const meta = await metadata(provider);
    const configured = provider.userInfoEndpoint;
    const endpoint = configured && loopbackUrl(configured) ? configured : meta.config.userinfo_endpoint ?? null;
    if (!endpoint) return warn("USERINFO_ENDPOINT_MISSING", "UseUserInfoEndpointforClaims is on, but no UserInfoEndpoint is set and the provider metadata has none.");
    if (!accessToken) return warn("USERINFO_ACCESS_TOKEN_MISSING", `The ${flowOf(provider)} response (response type ${provider.responseType}) carries no access token for the UserInfo request.`);
    let response;
    try {
      response = await fetch(endpoint, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    } catch (error) {
      return warn("USERINFO_UNAVAILABLE", `The UserInfo endpoint ${endpoint} is not reachable (${error.message}).`);
    }
    if (response.status === 401 || response.status === 403) {
      const body = await response.json().catch(() => ({}));
      return warn("USERINFO_UNAUTHORIZED", `The UserInfo endpoint answered ${response.status}${body.error ? ` ${body.error}` : ""}${body.error_description ? `: ${body.error_description}` : ""}.`);
    }
    if (!response.ok) return warn("USERINFO_UNAVAILABLE", `The UserInfo endpoint answered ${response.status}.`);
    const claims = await response.json().catch(() => null);
    if (!claims || typeof claims !== "object") return warn("USERINFO_UNAVAILABLE", "The UserInfo response is not a JSON object.");
    // OpenID Connect Core 5.3.2: the UserInfo sub must be the id_token's.
    if (claims.sub !== subject) return warn("USERINFO_SUBJECT_MISMATCH", "The UserInfo response is for another subject than the id_token.");
    return keptClaims(claims, [], 20);
  }

  // ---- the provider's response at the reply URL ----
  async function providerResponse(req, res, url, message) {
    const raw = message.state.startsWith(STATE_PREFIX) ? message.state.slice(STATE_PREFIX.length) : null;
    const props = unprotect(raw);
    const returnUrl = safeReturnUrl(props?.r);
    if (!props) return fail(req, res, url, new SignInProblem("The sign-in response does not carry a state this portal issued.", "EXTERNAL_LOGIN_STATE_INVALID"));
    const provider = providerList().find((item) => item.slug === props.p);
    if (!provider) return fail(req, res, url, new SignInProblem("The sign-in response is for a provider this site no longer configures.", "EXTERNAL_LOGIN_PROVIDER_UNKNOWN"), { returnUrl });
    if (trimPath(url.pathname) !== trimPath(provider.callbackPath))
      return fail(req, res, url, new SignInProblem("The sign-in response arrived at a path that is not the provider's reply URL.", "EXTERNAL_LOGIN_REPLY_PATH"), { returnUrl });
    if (message.error)
      return fail(req, res, url, new SignInProblem(`The identity provider returned ${message.error}${message.error_description ? `: ${message.error_description}` : ""}.`, "EXTERNAL_LOGIN_PROVIDER_ERROR"), { returnUrl });
    // The code flow signs in with the token response's id_token; the hybrid and implicit flows
    // with the front-channel id_token (Learn: hybrid follows the implicit grant).
    let idToken = message.id_token;
    let accessToken = message.access_token;
    let claims;
    try {
      if (codeFlow(provider)) {
        if (!message.code) throw new SignInProblem("The sign-in response has no authorization code.", "EXTERNAL_LOGIN_TOKEN_INVALID");
        const tokens = await redeemCode(provider, message.code, props.v ?? null);
        idToken = tokens.id_token;
        accessToken = tokens.access_token ?? null;
        if (!idToken) throw new SignInProblem("The token response has no id_token.", "EXTERNAL_LOGIN_TOKEN_INVALID", 502);
      } else if (!idToken) throw new SignInProblem("The sign-in response has no id_token.", "EXTERNAL_LOGIN_TOKEN_INVALID");
      claims = await validateToken(provider, idToken);
      // OpenID Connect Core 3.2.2.9 and 3.3.2.11: an at_hash binds the access token to the id_token.
      if (accessToken && claims.at_hash && claims.at_hash !== createHash("sha256").update(accessToken).digest().subarray(0, 16).toString("base64url"))
        throw new SignInProblem("The access token does not match the id_token's at_hash.", "EXTERNAL_LOGIN_TOKEN_INVALID");
    } catch (problem) {
      if (!(problem instanceof SignInProblem)) throw problem;
      return fail(req, res, url, problem, { returnUrl });
    }
    const nonceCookie = nonceCookieName(claims.nonce);
    if (parseCookies(req.headers.cookie)[nonceCookie] !== "N")
      return fail(req, res, url, new SignInProblem("The sign-in response does not belong to a sign-in started in this browser (no matching OpenIdConnect.nonce cookie).", "EXTERNAL_LOGIN_NONCE_MISSING"), { returnUrl });
    const cleared = `${nonceCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
    const issued = Number(claims.nonce.split(".")[0]);
    if (!(issued > 0) || Date.now() - issued > provider.nonceLifetimeMs)
      return fail(req, res, url, new SignInProblem("The sign-in nonce has expired: sign in again.", "EXTERNAL_LOGIN_NONCE_EXPIRED"), { returnUrl, cookies: [cleared] });
    if (message.code && claims.c_hash && claims.c_hash !== createHash("sha256").update(message.code).digest().subarray(0, 16).toString("base64url"))
      return fail(req, res, url, new SignInProblem("The authorization code does not match the id_token's c_hash.", "EXTERNAL_LOGIN_TOKEN_INVALID"), { returnUrl, cookies: [cleared] });
    const kept = keptClaims(claims, ["nonce", "c_hash", "at_hash", "iat", "nbf", "exp", "aud", "iss"]);
    const userinfoClaims = provider.useUserInfo ? await userInfo(provider, accessToken, claims.sub, url) : null;
    const external = protect({ p: provider.slug, s: claims.sub, c: kept, ...(userinfoClaims ? { u: userinfoClaims } : {}), t: Date.now() });
    const target = `/Account/Login/ExternalLoginCallback?ReturnUrl=${encodeURIComponent(returnUrl)}${props.i ? `&InvitationCode=${encodeURIComponent(props.i)}` : ""}`;
    return redirect(res, target, "external-login-response", [cleared, `${externalCookieName()}=${external}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${EXTERNAL_LIFETIME_MS / 1000}`]);
  }

  // ---- mapping the external identity to a contact ----
  /** The Account/Register/RegistrationDisabledMessage snippet (Learn) as text, else a local message. */
  const registrationDisabledMessage = () => {
    const snippet = portal().snippets?.["Account/Register/RegistrationDisabledMessage"];
    const value =
      typeof snippet === "string"
        ? snippet
            .replace(/<\/?(?:p|div|br|li|ul|ol|h[1-6]|section|article|table|tr|td|th)\b[^>]*>/gi, " ")
            .replace(/<[^>]*>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, "&")
            .replace(/\s+/g, " ")
            .trim()
        : "";
    return value || "Registration is disabled for this site.";
  };
  const registrationDisabled = () => new SignInProblem(registrationDisabledMessage(), "REGISTRATION_DISABLED", 403);
  /** UserInfo claims of an external sign-in, when the provider reads them (UseUserInfoEndpointforClaims). */
  const userinfoOf = (provider, external) => (provider.useUserInfo ? external.u ?? null : null);
  async function applyLoginClaims(provider, contactId, claims, userinfo = null) {
    const fields = contactFieldsFromClaims(claims, provider.loginClaims, { defaults: false, userinfo });
    const contact = contactById(contactId);
    const mapping = contactMapping();
    if (!mapping || !contact || !Object.keys(fields).length || Object.entries(fields).every(([name, value]) => contact[name] === value)) return;
    await store.update(mapping.logicalName, contactId, fields, { admin: true });
    record("sign-in", mapping.logicalName, { provider: provider.id, loginClaimsMapping: provider.loginClaims, fields: Object.keys(fields).join(",") }, key(contactId));
  }
  async function register(provider, external, invitation = null) {
    const claims = external.c ?? {};
    const userinfo = userinfoOf(provider, external);
    const email = contactFieldsFromClaims(claims, provider.registrationClaims, { userinfo }).emailaddress1 ?? emailClaim(claims);
    if (settings().requireUniqueEmail && email && contactRows().some((item) => String(item.row.emailaddress1 ?? "").trim().toLowerCase() === email.toLowerCase()))
      throw new SignInProblem(`Email already in use: ${email} belongs to another contact (Authentication/UserManager/UserValidator/RequireUniqueEmail).`, "REGISTRATION_EMAIL_IN_USE", 409);
    let contactId;
    let externalIdentityId;
    await store.transact(() => {
      contactId = createContactRow(provider, claims, userinfo);
      externalIdentityId = createIdentityRow(provider, external.s, contactId, invitation ? "invitation" : "registration", invitation ? { invitationId: invitation.id } : {});
      if (invitation) applyInvitation(invitation, contactId);
    });
    const origin = invitation ? "invitation" : "registration";
    record("registration", "contact", { contactId, provider: provider.id, username: external.s, origin, ...(invitation ? { invitationId: invitation.id } : {}) }, contactId);
    record("registration", IDENTITY_TABLE, { externalIdentityId, contactId, provider: provider.id, username: external.s, origin }, contactId);
    return { contactId, route: invitation ? "external-sign-in-invitation" : "external-sign-in-registration" };
  }

  // ---- invitations (adx_invitation) ----
  const invitationMapping = () => {
    try {
      return store.resolveMapping(INVITATION_TABLE);
    } catch {
      return null;
    }
  };
  function findInvitation(code) {
    const mapping = invitationMapping();
    const wanted = text(code);
    if (!mapping || !wanted) return { problem: "The invitation code is not valid." };
    const row = tableRows(mapping.logicalName).find((item) => String(item.adx_invitationcode ?? "").trim().toLowerCase() === wanted.toLowerCase());
    if (!row || !active(row)) return { problem: "The invitation code is not valid." };
    const expiry = row.adx_expirydate ? new Date(String(scalar(row.adx_expirydate))) : null;
    // adx_expirydate is date-only: the invitation is valid through that day.
    if (expiry && !Number.isNaN(expiry.getTime()) && Date.now() > Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth(), expiry.getUTCDate() + 1))
      return { problem: "The invitation has expired." };
    const type = Number(scalar(row.adx_type) ?? INVITATION_SINGLE) === INVITATION_GROUP ? "group" : "single";
    const redemptions = Number(scalar(row.adx_redemptions) ?? 0) || 0;
    const maximum = Number(scalar(row.adx_maximumredemptions) ?? 0) || null;
    if (type === "single" && (lookupOf(row, "adx_redeemedcontact") || Number(scalar(row.statuscode)) === INVITATION_REDEEMED))
      return { problem: "The invitation has already been redeemed." };
    if (type === "group" && maximum && redemptions >= maximum) return { problem: "The invitation has reached its maximum number of redemptions." };
    const invited = lookupOf(row, "adx_invitecontact") || null;
    if (type === "single" && (!invited || !active(contactById(invited)))) return { problem: "The invited contact is missing or inactive in the local data." };
    return { invitation: { id: key(row[mapping.idColumn]), mapping, row, type, redemptions, maximum, invited } };
  }
  /** Web roles to assign on redemption: the invitation's web-role association rows. */
  function invitationRoles(invitation) {
    const relationships = Object.values(invitation.mapping.relationships ?? {}).filter((rel) => rel.many && rel.intersect && WEB_ROLE_TABLES.has(rel.entity));
    // Dataverse reference: adx_invitation_mspp_webrole_powerpagecomponent (adx_invitationid).
    const intersects = relationships.length
      ? relationships.map((rel) => ({ table: rel.intersect.entity, from: rel.intersect.from, to: rel.intersect.to }))
      : [{ table: "adx_invitation_mspp_webrole_powerpagecomponent", from: "adx_invitationid", to: "powerpagecomponentid" }];
    const known = new Set(webRoles().map((role) => key(role.id)));
    return [...new Set(intersects.flatMap((item) => tableRows(item.table).filter((row) => same(row[item.from], invitation.id)).map((row) => lookupId(row[item.to]))))].filter((roleId) => known.has(roleId));
  }
  /** Inside a transaction: the documented redemption effects (account, web roles, redemption state). */
  function applyInvitation(invitation, contactId) {
    const contact = contactMapping();
    const account = lookupOf(invitation.row, "adx_assigntoaccount");
    if (account && contact) store.updateRecord(contact.logicalName, contactId, { parentcustomerid: { id: account, logical_name: "account" } }, { admin: true });
    const roles = invitationRoles(invitation);
    if (roles.length) {
      const simulator = (store.state.simulator ??= {});
      const existing = new Set((simulator.contactRoles ?? []).map((item) => `${key(item.contactId)}:${key(item.roleId)}`));
      simulator.contactRoles = [...(simulator.contactRoles ?? []), ...roles.filter((roleId) => !existing.has(`${key(contactId)}:${roleId}`)).map((roleId) => ({ contactId: key(contactId), roleId }))];
    }
    const redemptions = invitation.redemptions + 1;
    const done = invitation.type === "single" || (invitation.maximum && redemptions >= invitation.maximum);
    store.updateRecord(
      invitation.mapping.logicalName,
      invitation.id,
      {
        adx_redemptions: redemptions,
        ...(invitation.type === "single" ? { adx_redeemedcontact: { id: key(contactId), logical_name: "contact", name: contactName(contactById(contactId)) ?? "" } } : {}),
        ...(done ? { statuscode: INVITATION_REDEEMED } : {}),
      },
      { admin: true },
    );
    if (lookupOf(invitation.row, "adx_redemptionworkflow"))
      diagnostic({ code: "INVITATION_WORKFLOW_NOT_RUN", severity: "info", message: "The invitation's redemption workflow is a Dataverse process; the local runtime does not run it.", id: invitation.id });
    return roles;
  }
  async function redeem(provider, external, code) {
    const found = findInvitation(code);
    if (found.problem) throw new SignInProblem(found.problem, "INVITATION_INVALID");
    const { invitation } = found;
    if (invitation.type === "group") return register(provider, external, invitation);
    let externalIdentityId;
    let roles = [];
    await store.transact(() => {
      externalIdentityId = createIdentityRow(provider, external.s, invitation.invited, "invitation", { invitationId: invitation.id });
      roles = applyInvitation(invitation, invitation.invited);
    });
    record("registration", IDENTITY_TABLE, { externalIdentityId, contactId: invitation.invited, provider: provider.id, username: external.s, origin: "invitation", invitationId: invitation.id, webRoles: roles.join(",") }, invitation.invited);
    return { contactId: invitation.invited, route: "external-sign-in-invitation" };
  }

  /** The documented decision for an external sign-in (identity, email mapping, registration). */
  async function resolveLogin(provider, external, { invitationCode = null } = {}) {
    const flags = settings();
    const existing = findIdentity(provider, external.s);
    if (existing) {
      const contactId = lookupOf(existing, "adx_contactid");
      if (!active(contactById(contactId))) throw new SignInProblem("Invalid sign-in attempt.", "EXTERNAL_LOGIN_CONTACT_INACTIVE", 403);
      await applyLoginClaims(provider, contactId, external.c ?? {}, userinfoOf(provider, external));
      return { contactId, route: "external-sign-in" };
    }
    const email = emailClaim(external.c ?? {});
    if (provider.emailMapping && email) {
      const matches = contactRows().filter((item) => active(item.row) && String(item.row.emailaddress1 ?? "").trim().toLowerCase() === email.toLowerCase());
      if (matches.length === 1) {
        let externalIdentityId;
        await store.transact(() => {
          externalIdentityId = createIdentityRow(provider, external.s, matches[0].id, "email-mapping");
        });
        record("external-identity", IDENTITY_TABLE, { externalIdentityId, contactId: matches[0].id, provider: provider.id, username: external.s, origin: "email-mapping" }, matches[0].id);
        return { contactId: matches[0].id, route: "external-sign-in-email-mapping" };
      }
    }
    if (!flags.registration || !provider.registration) throw registrationDisabled();
    if (invitationCode && flags.invitation) return redeem(provider, external, invitationCode);
    if (flags.openRegistration) return register(provider, external);
    if (flags.invitation) return { invitationRequired: true };
    throw registrationDisabled();
  }
  async function externalLoginCallback(req, res, url) {
    const returnUrl = safeReturnUrl(returnUrlParameter(url.searchParams));
    const external = readExternal(req);
    if (!external) return redirect(res, `${loginPath(portal())}?ReturnUrl=${encodeURIComponent(returnUrl)}`, "external-login-missing", [clearExternal()]);
    const provider = providerList().find((item) => item.slug === external.p);
    if (!provider) return fail(req, res, url, new SignInProblem("The external sign-in is for a provider this site no longer configures.", "EXTERNAL_LOGIN_PROVIDER_UNKNOWN"), { returnUrl, cookies: [clearExternal()] });
    const invitationCode = text(url.searchParams.get("InvitationCode") ?? url.searchParams.get("invitationCode"));
    let outcome;
    try {
      outcome = await resolveLogin(provider, external, { invitationCode });
    } catch (problem) {
      if (!(problem instanceof SignInProblem)) throw problem;
      return fail(req, res, url, problem, { returnUrl, cookies: [clearExternal()] });
    }
    if (outcome.invitationRequired) return redirect(res, `/Account/Login/RedeemInvitation?ReturnUrl=${encodeURIComponent(returnUrl)}`, "invitation-required");
    return redirect(res, returnUrl, outcome.route, [sessions.cookie({ contactId: outcome.contactId, provider: provider.slug }), clearExternal()]);
  }

  // ---- invitation redemption page ----
  async function redeemPage(req, res, url, { status = 200, code = "", error = null, returnUrl }) {
    const external = readExternal(req);
    const provider = external ? providerList().find((item) => item.slug === external.p) : null;
    const pending = provider ? `<p class="paqvilo-mirage-pending-external">Signed in with ${escapeHtml(provider.caption ?? provider.key)}${external.c?.email ? ` as ${escapeHtml(external.c.email)}` : ""}. Enter your invitation code to finish registering.</p>` : "";
    const content = [
      `<section class="container paqvilo-mirage-redeem-invitation" style="margin:24px auto;max-width:760px">`,
      `<h1>Redeem invitation</h1>`,
      error ? `<div class="alert alert-danger" role="alert">${escapeHtml(error)}</div>` : "",
      pending,
      `<form method="post" action="/Account/Login/RedeemInvitation?ReturnUrl=${escapeHtml(encodeURIComponent(returnUrl))}">`,
      `<input name="__RequestVerificationToken" type="hidden" value="${escapeHtml(csrf)}">`,
      `<div class="form-group"><label for="InvitationCode">Invitation code</label><input class="form-control" id="InvitationCode" name="InvitationCode" type="text" value="${escapeHtml(code)}" required></div>`,
      `<button type="submit" class="btn btn-primary">Register</button>`,
      `</form>`,
      `</section>`,
    ].join("");
    return renderPage(req, res, url, { status, title: "Redeem invitation", content, route: "redeem-invitation" });
  }
  async function redeemInvitation(req, res, url, { language }) {
    const flags = settings();
    const returnUrl = safeReturnUrl(returnUrlParameter(url.searchParams));
    if (!flags.registration || !flags.invitation) {
      const problem = registrationDisabled();
      diagnostic({ code: problem.code, severity: "warning", message: problem.message, path: url.pathname });
      return renderSignIn(req, res, url, { status: problem.status, returnUrl, error: problem.message });
    }
    if (req.method === "GET") return redeemPage(req, res, url, { code: text(url.searchParams.get("InvitationCode") ?? url.searchParams.get("invitation")) ?? "", returnUrl });
    const form = formOf(await readBody(req));
    const code = text(form.InvitationCode) ?? "";
    if (form.__RequestVerificationToken !== csrf) return redeemPage(req, res, url, { status: 400, code, returnUrl, error: "The anti-forgery token is missing or invalid: reload the page and try again." });
    const found = findInvitation(code);
    if (found.problem) return redeemPage(req, res, url, { status: 400, code, returnUrl, error: found.problem });
    const external = readExternal(req);
    const provider = external ? providerList().find((item) => item.slug === external.p) : null;
    if (!provider) {
      // No pending external sign-in: sign in with a provider, carrying the code.
      const providers = providerList();
      const single = loginButtonProvider(portal(), providers) ?? (providers.length === 1 ? providers[0] : null);
      if (single) return challenge(res, single, { returnUrl, invitationCode: code, language: languageCode(language) });
      return renderSignIn(req, res, url, { returnUrl, invitationCode: code });
    }
    let outcome;
    try {
      if (findIdentity(provider, external.s)) outcome = await resolveLogin(provider, external);
      else outcome = await redeem(provider, external, code);
    } catch (problem) {
      if (!(problem instanceof SignInProblem)) throw problem;
      return redeemPage(req, res, url, { status: problem.status ?? 400, code, returnUrl, error: problem.message });
    }
    return redirect(res, returnUrl, outcome.route, [sessions.cookie({ contactId: outcome.contactId, provider: provider.slug }), clearExternal()]);
  }

  // ---- LogOff ----
  async function logOff(req, res, url) {
    if (!identity()?.contactId)
      // reference-portal: LogOff needs a signed-in user; an anonymous request is sent to the sign-in path.
      return redirect(res, `${loginPath(portal())}?ReturnUrl=${encodeURIComponent(url.pathname)}`, "sign-out-anonymous");
    const returnUrl = safeReturnUrl(returnUrlParameter(url.searchParams));
    const session = sessions.read(req.headers.cookie);
    const provider = session?.provider ? providerList().find((item) => item.slug === session.provider) : null;
    const signedOut = sessions.cookie({ contactId: null });
    if (provider?.externalLogout && idp) {
      const meta = await metadata(provider);
      const local = (value) => {
        const target = new URL(value, origin());
        return new URL(target.pathname + target.search + target.hash, origin()).href;
      };
      const target = provider.postLogoutRedirectUri ? local(provider.postLogoutRedirectUri) : new URL(returnUrl, origin()).href;
      return redirect(res, `${meta.config.end_session_endpoint}?${new URLSearchParams({ post_logout_redirect_uri: target })}`, "sign-out-external", [signedOut]);
    }
    return redirect(res, returnUrl, "sign-out", [signedOut]);
  }

  /**
   * Answers the external sign-in routes; false when the request is not one of them.
   * `language`: the request's website language code, when its URL carried one.
   */
  async function route(req, res, url, { language = null } = {}) {
    const path = trimPath(url.pathname);
    const account = ACCOUNT_PATH.exec(path)?.[1];
    if (account === "logoff" && ["GET", "HEAD", "POST"].includes(req.method)) {
      await logOff(req, res, url);
      return true;
    }
    if (account === "externallogin" && req.method === "POST") {
      await externalLogin(req, res, url, { language });
      return true;
    }
    if (account === "externallogincallback" && ["GET", "HEAD"].includes(req.method)) {
      await externalLoginCallback(req, res, url);
      return true;
    }
    if (account === "redeeminvitation" && ["GET", "HEAD", "POST"].includes(req.method)) {
      await redeemInvitation(req, res, url, { language });
      return true;
    }
    if (callbackPaths().has(path)) {
      // A query answer only where a provider of that reply URL uses response_mode=query.
      if (["GET", "HEAD"].includes(req.method) && providerList().some((provider) => provider.responseMode === "query" && trimPath(provider.callbackPath) === path)) {
        const message = providerMessage(Object.fromEntries(url.searchParams));
        if (message) {
          await providerResponse(req, res, url, message);
          return true;
        }
      } else if (req.method === "POST" && isForm(req)) {
        const bytes = await readBody(req);
        const message = providerMessage(formOf(bytes));
        if (message) {
          await providerResponse(req, res, url, message);
          return true;
        }
        if (req.headers.origin && req.headers.origin !== origin()) throw Object.assign(new Error("Cross-origin requests are not allowed."), { status: 403 });
        replay(req, bytes);
      }
    }
    // LoginButtonAuthenticationType: the sign-in page goes straight to the default provider.
    if (["GET", "HEAD"].includes(req.method) && authRoute(url.pathname, req.method, { loginPath: loginPath(portal()) })?.kind === "sign-in-page" && !/\/(?:externallogin|register)$/.test(path) && !identity()?.contactId) {
      const provider = loginButtonProvider(portal(), providerList());
      if (provider && idp) {
        await challenge(res, provider, { returnUrl: safeReturnUrl(returnUrlParameter(url.searchParams)), invitationCode: text(url.searchParams.get("InvitationCode")), language: languageCode(language) });
        return true;
      }
    }
    return false;
  }

  /**
   * The cross-origin form post of the local identity provider to a reply URL: its origin,
   * or "null" (a browser's privacy settings can hide it); route() then accepts only a
   * provider response from a foreign origin.
   */
  function acceptsOrigin(req) {
    if (!idp || ![idp.origin, "null"].includes(req.headers.origin) || req.method !== "POST") return false;
    try {
      return callbackPaths().has(trimPath(new URL(req.url, origin()).pathname));
    } catch {
      return false;
    }
  }

  /** Providers as the sign-in page lists them (form fields of the platform's provider form). */
  function signInProviders() {
    const providers = providerList();
    const button = loginButtonProvider(portal(), providers);
    return providers.map((provider) => ({ id: provider.id, name: provider.key, caption: provider.caption, default: provider === button }));
  }

  function status() {
    const flags = settings();
    const providers = providerList();
    const button = loginButtonProvider(portal(), providers);
    const reason = !idp
      ? "The local identity provider is not running."
      : !flags.externalLogin
        ? "External sign-in is turned off (Authentication/Registration/ExternalLoginEnabled is false)."
        : !providers.length
          ? "No external identity provider is configured in the site settings."
          : null;
    return {
      available: Boolean(idp) && providers.length > 0,
      reason,
      origin: idp?.origin ?? null,
      port: idp?.port ?? null,
      providers: providers.map((provider) => ({
        id: provider.id,
        name: provider.key,
        type: provider.type,
        caption: provider.caption,
        callbackPath: provider.callbackPath,
        callbackSource: provider.callbackSource,
        authority: provider.id,
        authoritySource: provider.authoritySource,
        localAuthority: idp ? idp.authority(provider) : null,
        clientId: provider.clientId,
        responseType: provider.responseType,
        responseMode: provider.responseMode,
        flow: flowOf(provider),
        scope: provider.scope,
        // The secret is never reported, only whether one is configured.
        clientSecret: provider.clientSecret ? "configured" : null,
        tokenAuthMethod: provider.tokenAuthMethod,
        certificateKid: provider.certificateKid,
        pkce: codeFlow(provider),
        userInfo: { enabled: provider.useUserInfo, endpoint: provider.userInfoEndpoint, localEndpoint: !provider.userInfoEndpoint || !loopbackUrl(provider.userInfoEndpoint) },
        prompt: provider.prompt,
        acrValues: provider.acrValues,
        dynamicParameters: provider.dynamicParameters,
        problems: provider.problems,
        externalLogout: provider.externalLogout,
        registration: provider.registration,
        emailMapping: provider.emailMapping,
        default: provider === button,
      })),
      loginButton: { value: flags.loginButton, provider: button?.id ?? null },
      registration: {
        enabled: flags.registration,
        open: flags.openRegistration,
        invitation: flags.invitation,
        externalLogin: flags.externalLogin,
        localLogin: flags.localLogin,
        requireUniqueEmail: flags.requireUniqueEmail,
      },
    };
  }

  /** External identities in the local data, with how each was recorded locally. */
  function identities() {
    const contacts = new Map(contactRows().map((item) => [item.id, item.row]));
    const mappingId = store.state.mappings?.[IDENTITY_TABLE]?.idColumn ?? "adx_externalidentityid";
    const recorded = new Map(ledger().filter((entry) => entry.externalIdentityId).map((entry) => [key(entry.externalIdentityId), entry]));
    const providers = providerList();
    return {
      table: IDENTITY_TABLE,
      mapped: Boolean(store.state.mappings?.[IDENTITY_TABLE]),
      identities: identityRows().map((row) => {
        const contactId = lookupOf(row, "adx_contactid") || null;
        const entry = recorded.get(key(row[mappingId]));
        const provider = providers.find((item) => providerMatches(item, row.adx_identityprovidername));
        return {
          id: key(row[mappingId]) || null,
          contactId,
          contactName: contactName(contacts.get(contactId)),
          provider: row.adx_identityprovidername ?? null,
          providerName: provider?.key ?? null,
          username: row.adx_username ?? null,
          active: active(row),
          origin: entry?.kind ?? "data",
          recordedAt: entry?.at ?? null,
          ...(entry?.invitationId ? { invitationId: entry.invitationId } : {}),
        };
      }),
      registrations: [...ledger()].reverse(),
    };
  }

  /** The provider of a session cookie's provider slug, as GET /_sim/api/session reports it. */
  function sessionProvider(slug) {
    const provider = slug ? providerList().find((item) => item.slug === slug) : null;
    return provider ? { id: provider.id, name: provider.key, type: provider.type, caption: provider.caption, externalLogout: provider.externalLogout } : null;
  }

  return { start, close, route, acceptsOrigin, status, identities, signInProviders, sessionProvider, get identityProvider() { return idp; } };
}
