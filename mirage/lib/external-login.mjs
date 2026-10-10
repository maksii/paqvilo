import { createHash } from "node:crypto";
import { siteSetting } from "./redirects.mjs";

/**
 * External sign-in configuration derived from the portal's site settings (Learn: "Local
 * authentication, registration, and other settings", "Set up site authentication" and the
 * OpenID Connect, OAuth 2.0, SAML 2.0 and WS-Federation provider articles).
 * docs/sim-administration.md, "External sign-in", describes the flow these feed.
 */

const lower = (value) => String(value ?? "").trim().toLowerCase();
const flag = (value, fallback) => (lower(value) === "true" ? true : lower(value) === "false" ? false : fallback);
const text = (value) => {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
};

/** A .NET TimeSpan ("hh:mm:ss", "d.hh:mm:ss") or a number of minutes, in milliseconds. */
export function timeSpanMs(value) {
  const raw = text(value);
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 60_000);
  const match = /^(?:(\d+)\.)?(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(raw);
  if (!match) return null;
  const [, days = "0", hours, minutes, seconds = "0"] = match;
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

/** Registration and sign-in switches with their documented defaults. */
export function authenticationSettings(portal) {
  const s = (name) => siteSetting(portal, `Authentication/Registration/${name}`);
  // RequiresInvitation (and RequiresConfirmation) turn open registration off (Learn,
  // "Configure site settings": "enables invitation code feature and disables open registration").
  const requiresInvitation = flag(s("RequiresInvitation"), false);
  return {
    registration: flag(s("Enabled"), true),
    localLogin: flag(s("LocalLoginEnabled"), true),
    externalLogin: flag(s("ExternalLoginEnabled"), true),
    openRegistration: flag(s("OpenRegistrationEnabled"), true) && !requiresInvitation && !flag(s("RequiresConfirmation"), false),
    invitation: requiresInvitation || flag(s("InvitationEnabled"), true),
    requireUniqueEmail: flag(siteSetting(portal, "Authentication/UserManager/UserValidator/RequireUniqueEmail"), true),
    azureAdLogin: flag(s("AzureADLoginEnabled"), null),
    loginButton: text(s("LoginButtonAuthenticationType")),
  };
}

/** Site settings under a prefix, by provider name (case kept), with the remaining field names. */
function settingsUnder(portal, prefix) {
  const found = new Map();
  const wanted = prefix.toLowerCase();
  for (const key of Object.keys(portal.settings ?? {})) {
    if (!key.toLowerCase().startsWith(wanted)) continue;
    const [name, ...field] = key.slice(prefix.length).split("/");
    if (!name || !field.length) continue;
    const existing = [...found.keys()].find((item) => item.toLowerCase() === name.toLowerCase()) ?? name;
    if (!found.has(existing)) found.set(existing, {});
    found.get(existing)[field.join("/")] = siteSetting(portal, key);
  }
  return found;
}

const fieldOf = (fields, name) => {
  const key = Object.keys(fields ?? {}).find((item) => item.toLowerCase() === name.toLowerCase());
  return key === undefined ? null : text(fields[key]);
};

/** The path of a configured reply URL (absolute URL or site-relative path), else null. */
export function replyPath(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    return new URL(raw, "http://local.invalid").pathname || "/";
  } catch {
    return null;
  }
}

const slugOf = (value) => lower(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "provider";
const MICROSOFT_AUTHORITY = /^https:\/\/login\.(?:windows\.net|microsoftonline\.com)\/[^/?#\s]+\/?(?:v2\.0\/?)?$/i;
/** A Microsoft Entra authority URL (https://login.windows.net/<tenant>/ or login.microsoftonline.com). */
export const isMicrosoftAuthority = (value) => MICROSOFT_AUTHORITY.test(String(value ?? "").trim());
// A tenant is a directory (tenant) ID or a domain name such as contoso.onmicrosoft.com;
// placeholders ({tenant}) and the multi-tenant endpoints (common, organizations) are not.
const TENANT_AUTHORITY = /^https:\/\/login\.(?:windows\.net|microsoftonline\.com)\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)\/?(?:v2\.0\/?)?$/i;
/** A Microsoft Entra authority of one tenant: its directory ID or domain name. */
export const isTenantAuthority = (value) => TENANT_AUTHORITY.test(String(value ?? "").trim());

/** Microsoft Entra authorities that the portal's own sources post as the provider (sign-in forms). */
function sourceAuthorities(portal) {
  const found = new Set();
  const sources = [
    ...Object.values(portal.templates ?? {}).map((template) => (typeof template === "string" ? template : template?.source ?? "")),
    ...Object.values(portal.snippets ?? {}),
    ...(portal.pages ?? []).map((page) => page.html ?? ""),
  ];
  for (const source of sources)
    for (const match of String(source ?? "").matchAll(/https:\/\/login\.(?:windows\.net|microsoftonline\.com)\/[0-9a-f-]{36}\//gi)) found.add(match[0].toLowerCase());
  return [...found].sort();
}

// Katana's OAuth 2.0 middlewares answer on /signin-<provider> by default.
const OAUTH_CALLBACKS = { microsoft: "/signin-microsoft", google: "/signin-google", facebook: "/signin-facebook", twitter: "/signin-twitter", linkedin: "/signin-linkedin", yahoo: "/signin-yahoo" };
const ONE_HOUR = 60 * 60 * 1000;
/** Prompt values Learn lists for Authentication/OpenIdConnect/{Provider}/Prompt and the ExternalLogin prompt parameter. */
export const PROMPT_VALUES = Object.freeze(["none", "login", "consent", "select_account", "create"]);
const PARAMETER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The authorization code flow and request options of an OpenID Connect provider (Learn, "Set up
 * an OpenID Connect provider"): ClientSecret (client_secret_post, the default), or
 * TokenEndPointAuthenticatedMethod private_key_jwt with PrivateKeyJwt/CertificateObject
 * {"kid":"<thumbprint>"}; UseUserInfoEndpointforClaims and UserInfoEndpoint; Prompt (none,
 * login, consent, select_account or create); AcrValues; AllowedDynamicAuthorizationParameters
 * (comma-separated names). Problems with a value are listed in `problems`.
 */
export function oidcOptions(fields = {}) {
  const problems = [];
  const method = lower(fieldOf(fields, "TokenEndPointAuthenticatedMethod"));
  if (method && !["client_secret_post", "private_key_jwt"].includes(method)) problems.push(`TokenEndPointAuthenticatedMethod "${method}" is not client_secret_post or private_key_jwt; client_secret_post is used.`);
  const certificateObject = fieldOf(fields, "PrivateKeyJwt/CertificateObject");
  let certificateKid = null;
  if (certificateObject) {
    try {
      const parsed = JSON.parse(certificateObject);
      if (parsed && typeof parsed.kid === "string" && parsed.kid.trim()) certificateKid = parsed.kid.trim();
      else problems.push('PrivateKeyJwt/CertificateObject must be {"kid":"<certificate thumbprint>"}.');
    } catch {
      problems.push('PrivateKeyJwt/CertificateObject is not JSON; it must be {"kid":"<certificate thumbprint>"}.');
    }
  }
  const promptSetting = lower(fieldOf(fields, "Prompt"));
  if (promptSetting && !PROMPT_VALUES.includes(promptSetting)) problems.push(`Prompt "${promptSetting}" is not one of ${PROMPT_VALUES.join(", ")}; it is not sent.`);
  const dynamicParameters = [];
  for (const name of String(fieldOf(fields, "AllowedDynamicAuthorizationParameters") ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
    if (PARAMETER_NAME.test(name)) dynamicParameters.push(name);
    else problems.push(`AllowedDynamicAuthorizationParameters lists "${name}", which is not a parameter name.`);
  }
  return {
    clientSecret: fieldOf(fields, "ClientSecret"),
    tokenAuthMethod: method === "private_key_jwt" ? "private_key_jwt" : "client_secret_post",
    certificateKid,
    useUserInfo: flag(fieldOf(fields, "UseUserInfoEndpointforClaims"), false),
    userInfoEndpoint: fieldOf(fields, "UserInfoEndpoint"),
    prompt: PROMPT_VALUES.includes(promptSetting) ? promptSetting : null,
    acrValues: fieldOf(fields, "AcrValues"),
    dynamicParameters,
    problems,
  };
}

/**
 * External identity providers configured by site settings, in sign-in page order:
 * - Microsoft Entra ID ("AzureAD", the built-in provider): Authentication/Registration/
 *   AzureADLoginEnabled true, or an Authentication/OpenIdConnect/AzureAD/Authority. Its
 *   AuthenticationType is its authority: the setting, else the project's observed authority,
 *   else the authority the portal's own sign-in forms post, else the multi-tenant authority
 *   (reported as authoritySource "default"). The adapter posts back to the site root with
 *   scope "openid profile" (capture: signin-chain/summary.json).
 * - OpenID Connect providers with Authentication/OpenIdConnect/<name>/Authority.
 * - OAuth 2.0 providers with Authentication/OpenAuth/<Name>/ClientId (ConsumerKey, AppId).
 * - SAML 2.0 and WS-Federation providers with an AuthenticationType setting.
 * OpenID Connect providers without a RedirectUri use the site root, as the platform's built-in
 * provider does; the local OAuth 2.0, SAML 2.0 and WS-Federation providers exchange the
 * same OpenID Connect messages with the local identity provider.
 */
export function externalProviders(portal) {
  const settings = authenticationSettings(portal);
  if (!settings.externalLogin) return [];
  const providers = [];
  const oidc = settingsUnder(portal, "Authentication/OpenIdConnect/");
  const common = (fields, caption) => ({
    caption: fieldOf(fields, "Caption") ?? caption,
    externalLogout: flag(fieldOf(fields, "ExternalLogoutEnabled"), false),
    postLogoutRedirectUri: fieldOf(fields, "PostLogoutRedirectUri") ?? fieldOf(fields, "SignOutWreply"),
    registration: flag(fieldOf(fields, "RegistrationEnabled"), true),
    emailMapping: flag(fieldOf(fields, "AllowContactMappingWithEmail"), false),
    registrationClaims: fieldOf(fields, "RegistrationClaimsMapping"),
    loginClaims: fieldOf(fields, "LoginClaimsMapping"),
    nonceLifetimeMs: timeSpanMs(fieldOf(fields, "NonceLifetime")) ?? ONE_HOUR,
  });
  const azureEntry = [...oidc.entries()].find(([name]) => name.toLowerCase() === "azuread");
  const azureFields = azureEntry?.[1] ?? {};
  if (settings.azureAdLogin === true || (settings.azureAdLogin === null && fieldOf(azureFields, "Authority"))) {
    const configured = fieldOf(azureFields, "Authority");
    const observed = isTenantAuthority(portal.observed?.azureAdAuthority) ? String(portal.observed.azureAdAuthority).trim() : null;
    const fromSource = sourceAuthorities(portal)[0] ?? null;
    const authority = configured ?? observed ?? fromSource ?? "https://login.windows.net/common/";
    const redirect = fieldOf(azureFields, "RedirectUri");
    providers.push({
      key: azureEntry?.[0] ?? "AzureAD",
      slug: "azuread",
      type: "openidconnect",
      id: authority,
      authoritySource: configured ? "site-setting" : observed ? "observed" : fromSource ? "portal-source" : "default",
      aliases: ["azuread", authority.toLowerCase()],
      builtIn: true,
      clientId: fieldOf(azureFields, "ClientId") ?? "paqvilo-mirage-azuread",
      callbackPath: replyPath(redirect) ?? "/",
      callbackSource: redirect ? "site-setting" : "observed",
      responseType: fieldOf(azureFields, "ResponseType") ?? "code id_token",
      responseMode: lower(fieldOf(azureFields, "ResponseMode")) || "form_post",
      scope: fieldOf(azureFields, "Scope") ?? "openid profile",
      ...common(azureFields, "AzureAD"),
      ...oidcOptions(azureFields),
    });
  }
  for (const [name, fields] of oidc) {
    if (name.toLowerCase() === "azuread") continue;
    const authority = fieldOf(fields, "Authority");
    if (!authority) continue;
    const redirect = fieldOf(fields, "RedirectUri");
    providers.push({
      key: name,
      slug: `oidc-${slugOf(name)}`,
      type: "openidconnect",
      id: authority,
      authoritySource: "site-setting",
      aliases: [name.toLowerCase(), authority.toLowerCase()],
      clientId: fieldOf(fields, "ClientId") ?? `paqvilo-mirage-${slugOf(name)}`,
      callbackPath: replyPath(redirect) ?? "/",
      callbackSource: redirect ? "site-setting" : "default",
      responseType: fieldOf(fields, "ResponseType") ?? "code id_token",
      responseMode: lower(fieldOf(fields, "ResponseMode")) || "form_post",
      scope: fieldOf(fields, "Scope") ?? "openid",
      ...common(fields, name),
      ...oidcOptions(fields),
    });
  }
  for (const [name, fields] of settingsUnder(portal, "Authentication/OpenAuth/")) {
    const clientId = fieldOf(fields, "ClientId") ?? fieldOf(fields, "ConsumerKey") ?? fieldOf(fields, "AppId");
    if (!clientId) continue;
    providers.push({
      key: name,
      slug: `oauth-${slugOf(name)}`,
      type: "oauth2",
      id: name,
      authoritySource: "site-setting",
      aliases: [name.toLowerCase()],
      clientId,
      callbackPath: OAUTH_CALLBACKS[name.toLowerCase()] ?? `/signin-${slugOf(name)}`,
      callbackSource: "default",
      responseType: "id_token",
      responseMode: "form_post",
      scope: "openid",
      ...common(fields, name),
      ...oidcOptions(),
    });
  }
  for (const [prefix, type] of [["Authentication/SAML2/", "saml2"], ["Authentication/WsFederation/", "wsfederation"]])
    for (const [name, fields] of settingsUnder(portal, prefix)) {
      const authenticationType = fieldOf(fields, "AuthenticationType");
      if (!authenticationType) continue;
      const reply = fieldOf(fields, "AssertionConsumerServiceUrl") ?? fieldOf(fields, "Wreply");
      providers.push({
        key: name,
        slug: `${type}-${slugOf(name)}`,
        type,
        id: authenticationType,
        authoritySource: "site-setting",
        aliases: [name.toLowerCase(), authenticationType.toLowerCase()],
        clientId: fieldOf(fields, "ServiceProviderRealm") ?? fieldOf(fields, "Wtrealm") ?? `paqvilo-mirage-${slugOf(name)}`,
        callbackPath: replyPath(reply) ?? "/",
        callbackSource: reply ? "site-setting" : "default",
        responseType: "id_token",
        responseMode: "form_post",
        scope: "openid",
        ...common(fields, name),
        ...oidcOptions(),
      });
    }
  return providers;
}

/** The provider an ExternalLogin `provider` value (AuthenticationType, name or authority) names. */
export function resolveProvider(providers, value) {
  const wanted = lower(value);
  if (!wanted) return null;
  const exact = providers.find((provider) => provider.aliases.includes(wanted) || lower(provider.id) === wanted);
  if (exact) return exact;
  // The built-in provider is the site's Microsoft Entra tenant: portal forms post its authority.
  return isMicrosoftAuthority(value) ? providers.find((provider) => provider.builtIn) ?? null : null;
}

/** The provider LoginButtonAuthenticationType selects (the Sign In button goes straight to it). */
export function loginButtonProvider(portal, providers = externalProviders(portal)) {
  const value = authenticationSettings(portal).loginButton;
  return value ? resolveProvider(providers, value) : null;
}

/** A stable subject for a local contact's identity at a provider (when the data has none). */
export function presetSubject(provider, contactId) {
  const hex = createHash("sha256").update(`${lower(provider.id)}|${lower(contactId).replace(/[{}]/g, "")}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The email claims Learn lists for contact mapping with email: email, emails or upn. */
export function emailClaim(claims) {
  for (const name of ["email", "emails", "upn"]) {
    const value = Array.isArray(claims?.[name]) ? claims[name][0] : claims?.[name];
    if (typeof value === "string" && value.includes("@")) return value.trim();
  }
  return null;
}

/**
 * Contact fields from claims. A RegistrationClaimsMapping/LoginClaimsMapping value
 * ("firstname=given_name,lastname=family_name") maps text and boolean claims (Learn: claims
 * mapping supports only text and boolean contact attributes); without one, registration
 * fills first name, last name and primary email from given_name, family_name and the
 * email claim (local default). "field = userinfo.claim" reads the UserInfo response
 * (`userinfo`), and is ignored without one (Learn: only with UseUserInfoEndpointforClaims).
 */
export function contactFieldsFromClaims(claims, mapping, { defaults = true, userinfo = null } = {}) {
  const pairs = text(mapping)
    ? String(mapping)
        .split(",")
        .map((pair) => pair.split("=").map((part) => part.trim()))
        .filter(([field, claim]) => /^[a-z_][a-z0-9_]*$/i.test(field ?? "") && claim)
    : defaults
      ? [
          ["firstname", "given_name"],
          ["lastname", "family_name"],
          ["emailaddress1", "email"],
        ]
      : [];
  const fields = {};
  for (const [field, name] of pairs) {
    const fromUserInfo = /^userinfo\./i.test(name);
    if (fromUserInfo && !userinfo) continue;
    const source = fromUserInfo ? userinfo : claims;
    const claim = fromUserInfo ? name.slice("userinfo.".length) : name;
    const value = claim === "email" ? emailClaim(source) : source?.[claim];
    if (typeof value === "string" && value.trim()) fields[field.toLowerCase()] = value.trim();
    else if (typeof value === "boolean") fields[field.toLowerCase()] = value;
  }
  return fields;
}
