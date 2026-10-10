import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createPublicKey, verify } from "node:crypto";
import { createSimulator } from "../server.mjs";
import {
  authenticationSettings,
  contactFieldsFromClaims,
  emailClaim,
  externalProviders,
  loginButtonProvider,
  presetSubject,
  resolveProvider,
  timeSpanMs,
} from "../lib/external-login.mjs";
import { startIdentityProvider } from "../lib/identity-provider.mjs";


const AUTHORITY = "https://idp.example.test/local/";
const TENANT = "https://login.windows.net/0f0f0f0f-1111-4222-8333-444444444444/";
const settingsOf = (entries) => Object.fromEntries(entries.map(([name, value]) => [name, value]));
const portalOf = (entries, extra = {}) => ({ settings: settingsOf(entries), templates: {}, snippets: {}, pages: [], ...extra });

test("providers come from site settings: the built-in Entra provider, OpenID Connect, OAuth 2.0, SAML 2.0 and WS-Federation", () => {
  // ExampleApp-shaped: AzureADLoginEnabled, a caption, no Authority; the portal's own form posts the tenant authority.
  const sample = portalOf(
    [
      ["Authentication/Registration/AzureADLoginEnabled", "true"],
      ["Authentication/Registration/ExternalLoginEnabled", "true"],
      ["Authentication/OpenIdConnect/AzureAD/Caption", "Sign In"],
      ["Authentication/OpenAuth/Twitter/ConsumerKey", null],
      ["Authentication/OpenAuth/Microsoft/ClientId", ""],
    ],
    { snippets: { "Sign/In": `<button name="provider" value="${TENANT}">Sign in</button>` } },
  );
  const [entra, ...others] = externalProviders(sample);
  assert.equal(others.length, 0, "OpenAuth providers without a client ID are not configured");
  assert.deepEqual(
    { key: entra.key, slug: entra.slug, type: entra.type, id: entra.id, authoritySource: entra.authoritySource, caption: entra.caption, callbackPath: entra.callbackPath, callbackSource: entra.callbackSource, scope: entra.scope, responseType: entra.responseType, responseMode: entra.responseMode, builtIn: entra.builtIn, registration: entra.registration, emailMapping: entra.emailMapping, externalLogout: entra.externalLogout, nonceLifetimeMs: entra.nonceLifetimeMs },
    { key: "AzureAD", slug: "azuread", type: "openidconnect", id: TENANT, authoritySource: "portal-source", caption: "Sign In", callbackPath: "/", callbackSource: "observed", scope: "openid profile", responseType: "code id_token", responseMode: "form_post", builtIn: true, registration: true, emailMapping: false, externalLogout: false, nonceLifetimeMs: 3600000 },
  );
  // Templates are objects with a source; an observed authority wins over the portal's forms; else the multi-tenant default.
  const templated = portalOf([["Authentication/Registration/AzureADLoginEnabled", "true"]], { templates: { header: { source: `<form><button value="${TENANT}"></button></form>` } } });
  assert.equal(externalProviders(templated)[0].id, TENANT);
  const observed = { ...templated, observed: { azureAdAuthority: "https://login.microsoftonline.com/aaaaaaaa-0000-4000-8000-bbbbbbbbbbbb/" } };
  assert.deepEqual([externalProviders(observed)[0].id, externalProviders(observed)[0].authoritySource], ["https://login.microsoftonline.com/aaaaaaaa-0000-4000-8000-bbbbbbbbbbbb/", "observed"]);
  // A placeholder can never stand in for the tenant: the provider keeps the next source.
  assert.equal(externalProviders({ ...templated, observed: { azureAdAuthority: "https://login.windows.net/{tenant}/" } })[0].authoritySource, "portal-source");
  const bare = externalProviders(portalOf([["Authentication/Registration/AzureADLoginEnabled", "true"]]))[0];
  assert.deepEqual([bare.id, bare.authoritySource], ["https://login.windows.net/common/", "default"]);
  // A caption alone does not configure the built-in provider; an Authority does (unless turned off).
  assert.deepEqual(externalProviders(portalOf([["Authentication/OpenIdConnect/AzureAD/Caption", "Work account"]])), []);
  assert.equal(externalProviders(portalOf([["Authentication/OpenIdConnect/AzureAD/Authority", TENANT]]))[0].authoritySource, "site-setting");
  assert.deepEqual(externalProviders(portalOf([["Authentication/Registration/AzureADLoginEnabled", "false"], ["Authentication/OpenIdConnect/AzureAD/Authority", TENANT]])), []);

  const many = portalOf([
    ["Authentication/OpenIdConnect/B2C/Authority", "https://contoso.b2clogin.example/tfp/policy/v2.0/"],
    ["Authentication/OpenIdConnect/B2C/ClientId", "b2c-client"],
    ["Authentication/OpenIdConnect/B2C/RedirectUri", "https://portal.example.com/signin-b2c"],
    ["Authentication/OpenIdConnect/B2C/Caption", "Customers"],
    ["Authentication/OpenIdConnect/B2C/ExternalLogoutEnabled", "true"],
    ["Authentication/OpenIdConnect/B2C/PostLogoutRedirectUri", "https://portal.example.com/bye/"],
    ["Authentication/OpenIdConnect/B2C/RegistrationEnabled", "false"],
    ["Authentication/OpenIdConnect/B2C/AllowContactMappingWithEmail", "true"],
    ["Authentication/OpenIdConnect/B2C/NonceLifetime", "00:15:00"],
    ["Authentication/OpenIdConnect/B2C/Scope", "openid email"],
    ["Authentication/OpenAuth/Google/ClientId", "google-client"],
    ["Authentication/SAML2/Partner/AuthenticationType", "https://partner.example/entity"],
    ["Authentication/SAML2/Partner/AssertionConsumerServiceUrl", "https://portal.example.com/signin-saml_1"],
    ["Authentication/WsFederation/ADFS/AuthenticationType", "urn:adfs"],
    ["Authentication/WsFederation/ADFS/Wtrealm", "https://portal.example.com/"],
  ]);
  const providers = externalProviders(many);
  assert.deepEqual(
    providers.map((provider) => [provider.key, provider.slug, provider.type, provider.id, provider.callbackPath, provider.clientId]),
    [
      ["B2C", "oidc-b2c", "openidconnect", "https://contoso.b2clogin.example/tfp/policy/v2.0/", "/signin-b2c", "b2c-client"],
      ["Google", "oauth-google", "oauth2", "Google", "/signin-google", "google-client"],
      ["Partner", "saml2-partner", "saml2", "https://partner.example/entity", "/signin-saml_1", "paqvilo-mirage-partner"],
      ["ADFS", "wsfederation-adfs", "wsfederation", "urn:adfs", "/", "https://portal.example.com/"],
    ],
  );
  const b2c = providers[0];
  assert.deepEqual(
    [b2c.caption, b2c.externalLogout, b2c.postLogoutRedirectUri, b2c.registration, b2c.emailMapping, b2c.nonceLifetimeMs, b2c.scope],
    ["Customers", true, "https://portal.example.com/bye/", false, true, 900000, "openid email"],
  );
  // The provider form value is the AuthenticationType; names and any Microsoft authority resolve too.
  assert.equal(resolveProvider(providers, "https://contoso.b2clogin.example/tfp/policy/v2.0/"), b2c);
  assert.equal(resolveProvider(providers, "b2c"), b2c);
  assert.equal(resolveProvider(providers, "urn:ADFS")?.key, "ADFS");
  assert.equal(resolveProvider(providers, TENANT), null, "no built-in provider here");
  assert.equal(resolveProvider([entra], "https://login.microsoftonline.com/another-tenant/"), entra);
  assert.equal(resolveProvider(providers, "https://evil.example/"), null);
  assert.equal(loginButtonProvider({ ...many, settings: { ...many.settings, "Authentication/Registration/LoginButtonAuthenticationType": "Google" } })?.key, "Google");
  assert.equal(loginButtonProvider(many), null);
  // ExternalLoginEnabled false turns every provider off.
  assert.deepEqual(externalProviders({ ...many, settings: { ...many.settings, "Authentication/Registration/ExternalLoginEnabled": "false" } }), []);
});

test("registration switches, claims mapping, email claims and time spans follow the documented settings", () => {
  assert.deepEqual(authenticationSettings(portalOf([])), {
    registration: true,
    localLogin: true,
    externalLogin: true,
    openRegistration: true,
    invitation: true,
    requireUniqueEmail: true,
    azureAdLogin: null,
    loginButton: null,
  });
  // RequiresInvitation turns open registration off and invitations on.
  const invitationOnly = authenticationSettings(portalOf([["Authentication/Registration/RequiresInvitation", "true"], ["Authentication/Registration/InvitationEnabled", "false"]]));
  assert.deepEqual([invitationOnly.openRegistration, invitationOnly.invitation], [false, true]);
  assert.equal(authenticationSettings(portalOf([["Authentication/UserManager/UserValidator/RequireUniqueEmail", "False"]])).requireUniqueEmail, false);
  // Without a mapping, registration takes first name, last name and the email claim (email, emails or upn).
  assert.deepEqual(contactFieldsFromClaims({ given_name: "Dana", family_name: "New", upn: "dana@example.test" }), { firstname: "Dana", lastname: "New", emailaddress1: "dana@example.test" });
  assert.deepEqual(contactFieldsFromClaims({ given_name: "Dana", nickname: "D", verified: true, nested: { a: 1 } }, "firstname=given_name, nickname=nickname,donotemail=verified,jobtitle=nested,bad field=x"), { firstname: "Dana", nickname: "D", donotemail: true });
  assert.deepEqual(contactFieldsFromClaims({ given_name: "Dana" }, null, { defaults: false }), {});
  assert.equal(emailClaim({ emails: ["first@example.test", "second@example.test"] }), "first@example.test");
  assert.equal(emailClaim({ upn: "not-an-email" }), null);
  assert.deepEqual([timeSpanMs("00:15:00"), timeSpanMs("1.00:00:00"), timeSpanMs("90"), timeSpanMs("soon"), timeSpanMs(null)], [900000, 86400000, 5400000, null, null]);
  // Preset subjects are stable per provider and contact.
  const local = { id: AUTHORITY };
  assert.equal(presetSubject(local, "{ALEX}"), presetSubject(local, "alex"));
  assert.notEqual(presetSubject(local, "alex"), presetSubject({ id: TENANT }, "alex"));
  assert.match(presetSubject(local, "alex"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
});

const decode = (value) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const hiddenFields = (html) => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(([, name, value]) => [name, decode(value)]));
const formBody = (fields) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
const claimsOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

test("the local identity provider serves discovery, keys, the preset chooser, form_post and query answers, and end-session", async (t) => {
  const provisioned = [];
  const portalOrigin = "http://127.0.0.1:9";
  const provider = { slug: "oidc-local", key: "Local", caption: "Local <IdP>", clientId: "local-client", redirectUri: `${portalOrigin}/` };
  const idp = await startIdentityProvider({
    providers: () => [provider],
    users: async () => [{ contactId: "alex", subject: "sub-alex", name: "Alex Local", givenName: "Alex", familyName: "Local", email: "alex@example.test", description: "Member" }],
    provision: async (_provider, user) => provisioned.push(user.contactId),
    allowRedirect: (target) => new URL(target).origin === portalOrigin,
  });
  let closed = false;
  t.after(() => (closed ? undefined : idp.close()));
  assert.match(idp.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(idp.port, Number(new URL(idp.origin).port));
  const authority = `${idp.origin}/oidc-local/`;
  assert.equal(idp.authority(provider), authority);

  const discovery = await (await fetch(`${authority}.well-known/openid-configuration`)).json();
  assert.deepEqual(
    [discovery.issuer, discovery.authorization_endpoint, discovery.end_session_endpoint, discovery.jwks_uri, discovery.response_modes_supported, discovery.id_token_signing_alg_values_supported],
    [authority, `${authority}oauth2/authorize`, `${authority}oauth2/logout`, `${authority}discovery/keys`, ["form_post", "query"], ["RS256"]],
  );
  const { keys } = await (await fetch(discovery.jwks_uri)).json();
  assert.equal(keys.length, 1);
  assert.deepEqual([keys[0].kty, keys[0].alg, keys[0].use, typeof keys[0].kid], ["RSA", "RS256", "sig", "string"]);
  assert.equal((await fetch(`${idp.origin}/unknown/.well-known/openid-configuration`)).status, 404);
  assert.match(await (await fetch(`${idp.origin}/`)).text(), /Local identity provider \(simulation\)[\s\S]*Local &lt;IdP&gt;/);

  const params = { client_id: "local-client", redirect_uri: `${portalOrigin}/`, response_type: "code id_token", scope: "openid profile", state: "s-1", response_mode: "form_post", nonce: "n-1", ui_locales: "en-US" };
  const authorize = (extra = {}) => `${discovery.authorization_endpoint}?${new URLSearchParams({ ...params, ...extra })}`;
  // Like an online provider: an unknown client or an unregistered reply URL is answered with an error page.
  for (const [extra, message] of [
    [{ client_id: "other" }, /client_id &quot;other&quot; is not registered/],
    [{ redirect_uri: "http://127.0.0.1:9/elsewhere" }, /not the provider&#39;s registered reply URL/],
    // Power Pages does not support code token (Learn); the provider answers the documented types only.
    [{ response_type: "code token" }, /response_type &quot;code token&quot; is not supported/],
    [{ prompt: "sometimes" }, /prompt &quot;sometimes&quot; is not supported/],
    [{ prompt: "none login" }, /prompt=none cannot be combined/],
    [{ code_challenge: "short" }, /code_challenge must be 43 to 128/],
    [{ response_mode: "fragment" }, /response_mode must be form_post or query/],
    [{ scope: "profile" }, /scope must include openid/],
    [{ nonce: "" }, /state and nonce are required/],
  ]) {
    const response = await fetch(authorize(extra));
    assert.equal(response.status, 400, JSON.stringify(extra));
    assert.match(await response.text(), message);
  }
  // The chooser: preset users and a "New user" form; plainly a local simulation page.
  const chooser = await fetch(authorize());
  assert.equal(chooser.status, 200);
  assert.equal(chooser.headers.get("x-frame-options"), "DENY");
  const page = await chooser.text();
  assert.match(page, /<title>Local identity provider \(simulation\)<\/title>/);
  assert.match(page, /Signing in to http:\/\/127\.0\.0\.1:9 with Local &lt;IdP&gt; \(Local\) · local simulation, no credentials are used/);
  assert.match(page, /<li class="paqvilo-mirage-idp-user" data-subject="sub-alex" data-contact-id="alex">/);
  assert.match(page, /Continue as a new user/);
  assert.doesNotMatch(page, /microsoft|b2clogin|password/i);
  assert.equal(hiddenFields(page).nonce, "n-1");

  // Selecting a preset user provisions its identity and posts the answer back to the reply URL.
  const answered = await fetch(discovery.authorization_endpoint, formBody({ ...params, subject: "sub-alex" }));
  assert.equal(answered.status, 200);
  assert.match(answered.headers.get("set-cookie"), new RegExp(`^paqvilo-mirage-idp-${idp.port}=[^;]+; Path=/; HttpOnly; SameSite=Lax$`));
  const html = await answered.text();
  assert.match(html, /<body onload="document\.forms\[0\]\.submit\(\)"><main><form method="post" action="http:\/\/127\.0\.0\.1:9\/">/);
  const fields = hiddenFields(html);
  assert.deepEqual(Object.keys(fields), ["code", "id_token", "state"]);
  assert.equal(fields.state, "s-1");
  assert.deepEqual(provisioned, ["alex"]);
  const [header, payload, signature] = fields.id_token.split(".");
  const jwt = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  assert.deepEqual([jwt.alg, jwt.typ, jwt.kid], ["RS256", "JWT", keys[0].kid]);
  assert.ok(verify("sha256", Buffer.from(`${header}.${payload}`), createPublicKey({ key: keys[0], format: "jwk" }), Buffer.from(signature, "base64url")));
  const claims = claimsOf(fields.id_token);
  assert.deepEqual(
    [claims.iss, claims.aud, claims.sub, claims.oid, claims.email, claims.name, claims.given_name, claims.family_name, claims.nonce, claims.exp - claims.iat],
    [authority, "local-client", "sub-alex", "sub-alex", "alex@example.test", "Alex Local", "Alex", "Local", "n-1", 3600],
  );
  assert.equal(typeof claims.c_hash, "string");
  // login_hint (contact ID, subject or email) answers without the chooser.
  const hinted = await (await fetch(authorize({ login_hint: "ALEX" }))).text();
  assert.equal(claimsOf(hiddenFields(hinted).id_token).sub, "sub-alex");
  // A new user gets a fresh subject from the form; incomplete forms are rejected.
  const created = await (await fetch(discovery.authorization_endpoint, formBody({ ...params, subject: "new", given_name: "Dana", family_name: "New", email: "dana@example.test" }))).text();
  const fresh = claimsOf(hiddenFields(created).id_token);
  assert.match(fresh.sub, /^[0-9a-f-]{36}$/);
  assert.deepEqual([fresh.name, fresh.email], ["Dana New", "dana@example.test"]);
  assert.equal((await fetch(discovery.authorization_endpoint, formBody({ ...params, subject: "new", given_name: "Dana" }))).status, 400);
  assert.equal((await fetch(discovery.authorization_endpoint, formBody({ ...params, subject: "nobody" }))).status, 400);
  assert.deepEqual(provisioned, ["alex", "alex"], "new users are not provisioned");
  // response_mode=query appends the answer to the redirect URI; response_type id_token issues no code.
  const query = await fetch(authorize({ response_mode: "query", response_type: "id_token", login_hint: "alex@example.test" }), { redirect: "manual" });
  assert.equal(query.status, 302);
  const location = new URL(query.headers.get("location"));
  assert.equal(location.origin + location.pathname, `${portalOrigin}/`);
  assert.deepEqual([...location.searchParams.keys()], ["id_token", "state"]);
  // End-session: back to an allowed post_logout_redirect_uri (keeping state), else a signed-out page.
  const logout = await fetch(`${discovery.end_session_endpoint}?${new URLSearchParams({ post_logout_redirect_uri: `${portalOrigin}/_sim/#access`, state: "x" })}`, { redirect: "manual" });
  assert.equal(logout.status, 302);
  assert.equal(logout.headers.get("location"), `${portalOrigin}/_sim/?state=x#access`);
  assert.match(logout.headers.get("set-cookie"), new RegExp(`^paqvilo-mirage-idp-${idp.port}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0$`));
  const refused = await fetch(`${discovery.end_session_endpoint}?post_logout_redirect_uri=${encodeURIComponent("https://evil.example/")}`, { redirect: "manual" });
  assert.equal(refused.status, 200);
  assert.match(await refused.text(), /Signed out of the local identity provider[\s\S]*was not followed/);
  await idp.close();
  closed = true;
  await assert.rejects(fetch(`${idp.origin}/`));
});

// ---- the portal side ----

const page = (id, name, partial, parent = "home", template = "main") =>
  [`adx_webpageid: ${id}`, `adx_name: ${name}`, `adx_partialurl: ${partial}`, ...(parent ? [`adx_parentpageid: ${parent}`] : []), `adx_pagetemplateid: ${template}`].join("\n");

function portalFiles(settings) {
  return {
    "website.yml": "adx_name: Sign-in Site\nadx_websiteid: site\nadx_headerwebtemplateid: header\nadx_footerwebtemplateid: footer\nadx_defaultlanguage: lang-en\nadx_website_language: 1033",
    "websitelanguage.yml": "- adx_websitelanguageid: lang-en\n  adx_name: English",
    "web-pages/home/Home.webpage.yml": page("home", "Home", "/", null),
    "web-pages/members/Members.webpage.yml": page("members", "Members", "members"),
    "web-pages/ajax/Ajax.webpage.yml": page("ajax", "Ajax", "ajax", "home", "bare"),
    "page-templates/Main.pagetemplate.yml": "adx_pagetemplateid: main\nadx_webtemplateid: main",
    "page-templates/Bare.pagetemplate.yml": "adx_pagetemplateid: bare\nadx_webtemplateid: bare\nadx_usewebsiteheaderandfooter: false",
    "web-templates/Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
    "web-templates/Main.webtemplate.source.html": '<h1 id="title">{{ page.title }}</h1><p id="user">{% if user %}{{ user.fullname }}{% else %}anonymous{% endif %}</p>',
    "web-templates/Bare.webtemplate.yml": "adx_webtemplateid: bare\nadx_name: Bare",
    "web-templates/Bare.webtemplate.source.html": '<p id="posted">{{ request.params.a }}</p>',
    "web-templates/Header.webtemplate.yml": "adx_webtemplateid: header\nadx_name: Header",
    "web-templates/Header.webtemplate.source.html": '<header>{% if user %}<a id="sign-out" href="{{ website.sign_out_url_substitution }}">Sign out</a>{% else %}<a id="sign-in" href="{{ website.sign_in_url_substitution }}">Sign in</a>{% endif %}</header>',
    "web-templates/Footer.webtemplate.yml": "adx_webtemplateid: footer\nadx_name: Footer",
    "web-templates/Footer.webtemplate.source.html": "<footer>Footer</footer>",
    "webrole.yml": [
      "- adx_webroleid: member\n  adx_name: Member",
      "- adx_webroleid: reviewer\n  adx_name: Reviewer",
      "- adx_webroleid: signedin\n  adx_name: Authenticated Users\n  adx_authenticatedusersrole: true",
    ].join("\n"),
    "webpagerule.yml": "- adx_webpageaccesscontrolruleid: lock\n  adx_name: Members only\n  adx_webpageid: members\n  adx_right: 2\n  adx_scope: 1\n  adx_webpageaccesscontrolrule_webrole:\n  - member",
    "sitemarker.yml": "- adx_sitemarkerid: m-home\n  adx_name: Home\n  adx_pageid: home",
    "content-snippets/Disabled.contentsnippet.yml": "adx_contentsnippetid: disabled\nadx_name: Account/Register/RegistrationDisabledMessage",
    "content-snippets/Disabled.contentsnippet.value.html": "<p>New accounts are <b>closed</b>.</p>",
    "sitesetting.yml": settings.map(([name, value], index) => `- adx_sitesettingid: s${index}\n  adx_name: ${name}\n  adx_value: "${value}"`).join("\n"),
  };
}

const LOCAL_PROVIDER = [
  ["Authentication/Registration/ExternalLoginEnabled", "true"],
  ["Authentication/Registration/LocalLoginEnabled", "false"],
  ["Authentication/OpenIdConnect/Local/Authority", AUTHORITY],
  ["Authentication/OpenIdConnect/Local/ClientId", "local-client"],
  ["Authentication/OpenIdConnect/Local/Caption", "Local IdP"],
];

function initialState({ tables = {}, mappings = {} } = {}) {
  return {
    version: 1,
    mappings: {
      contact: { entitySet: "contacts", idColumn: "contactid", nameColumn: "fullname" },
      account: { entitySet: "accounts", idColumn: "accountid", nameColumn: "name" },
      ...mappings,
    },
    tables: {
      contact: [
        { contactid: "alex", fullname: "Alex Local", firstname: "Alex", lastname: "Local", emailaddress1: "alex@example.test", statecode: 0 },
        { contactid: "blair", fullname: "Blair Local", firstname: "Blair", lastname: "Local", emailaddress1: "blair@example.test", statecode: 0 },
        { contactid: "carol", fullname: "Carol Inactive", emailaddress1: "carol@example.test", statecode: 1 },
        { contactid: "casey", fullname: "Casey Invited", firstname: "Casey", lastname: "Invited", emailaddress1: "casey@example.test", statecode: 0 },
      ],
      account: [{ accountid: "helios", name: "Helios" }],
      ...tables,
    },
    permissions: [],
    settings: { permissionMode: "enforce" },
    simulator: {
      mode: "local",
      pageMode: "local",
      permissionSource: "configured",
      identity: { contactId: null, roleSource: "memberships", roles: [] },
      contactRoles: [{ contactId: "alex", roleId: "member" }],
      live: { allowWrites: false },
      endpoints: [],
    },
  };
}

async function simulator(t, settings = LOCAL_PROVIDER, state = initialState()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-external-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(portalFiles(settings))) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, "state.json"), port: 0, watch: false, initial: state });
  let closed = false;
  t.after(() => (closed ? undefined : app.close()));
  const { csrf } = await (await fetch(app.url + "/__sim/api/state?summary=1")).json();
  return { app, csrf, idp: app.identityProvider, close: async () => ((closed = true), app.close()) };
}

/** A browser-like client: one cookie jar for the host (browsers share cookies across ports). */
function client(app) {
  const jar = new Map();
  const remember = (response) => {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const index = pair.indexOf("=");
      if (/;\s*max-age=0/i.test(line)) jar.delete(pair.slice(0, index));
      else jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  };
  const request = async (target, { headers = {}, ...init } = {}) =>
    remember(await fetch(new URL(target, app.url), { redirect: "manual", ...init, headers: { "sec-fetch-site": "same-origin", ...(jar.size ? { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") } : {}), ...headers } }));
  return { jar, request };
}

/** The portal's provider form: POST ExternalLogin with the token /_layout/tokenhtml hands out. */
async function startSignIn(browser, { provider = AUTHORITY, returnUrl = "/", extra = {} } = {}) {
  const token = /value="([^"]+)"/.exec(await (await browser.request("/_layout/tokenhtml")).text())[1];
  const response = await browser.request(`/Account/Login/ExternalLogin?returnUrl=${encodeURIComponent(returnUrl)}`, formBody({ __RequestVerificationToken: token, provider, ...extra }));
  assert.equal(response.status, 302, await response.clone().text());
  return response;
}
/** The chooser's choice: a preset contact, or the "New user" form. */
async function choose(browser, authorize, { contactId = null, newUser = null } = {}) {
  const chooser = await browser.request(authorize, { headers: { "sec-fetch-site": "cross-site" } });
  const html = await chooser.text();
  assert.equal(chooser.status, 200, html);
  const subject = contactId ? new RegExp(`data-subject="([^"]+)" data-contact-id="${contactId}"`).exec(html)?.[1] : "new";
  assert.ok(subject, `the chooser lists ${contactId}`);
  const target = new URL(authorize);
  const answer = await browser.request(target.origin + target.pathname, formBody({ ...Object.fromEntries(target.searchParams), subject, ...(newUser ?? {}) }));
  assert.equal(answer.status, 200);
  return answer.text();
}
/** The auto-submitted form post of the provider's answer to the portal's reply URL. */
async function postBack(browser, html, idpOrigin) {
  const action = decode(/<form method="post" action="([^"]+)">/.exec(html)[1]);
  return browser.request(action, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: idpOrigin, "sec-fetch-site": "same-site" }, body: new URLSearchParams(hiddenFields(html)) });
}
/** A complete external sign-in; returns the ExternalLoginCallback response. */
async function signInThrough(browser, idp, options) {
  const challenge = await startSignIn(browser, options);
  const html = await choose(browser, challenge.headers.get("location"), options);
  const response = await postBack(browser, html, idp.origin);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("x-sim-route"), "external-login-response");
  return browser.request(response.headers.get("location"));
}
const text = async (response) => response.text();
const field = (html, id) => new RegExp(`id="${id}">([^<]*)<`).exec(html)?.[1] ?? null;
const json = async (browser, target) => (await browser.request(target)).json();

test("the portal's provider form runs the platform chain: ExternalLogin, the provider chooser, the form post to the site root, ExternalLoginCallback and the session", async (t) => {
  const { app, csrf, idp } = await simulator(t);
  assert.equal(idp.available, true);
  assert.match(idp.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(idp.origin, app.url, "the identity provider is cross-origin to the portal");
  assert.equal(idp.port, Number(new URL(idp.origin).port));
  assert.deepEqual(
    idp.providers.map(({ id, name, type, caption, callbackPath, default: isDefault, localAuthority, clientId }) => ({ id, name, type, caption, callbackPath, default: isDefault, localAuthority, clientId })),
    [{ id: AUTHORITY, name: "Local", type: "openidconnect", caption: "Local IdP", callbackPath: "/", default: false, localAuthority: `${idp.origin}/oidc-local/`, clientId: "local-client" }],
  );
  const browser = client(app);
  // GET /_sim/api/session and the admin status report the identity provider and its port.
  const anonymous = await json(browser, "/_sim/api/session");
  assert.deepEqual([anonymous.signedIn, anonymous.provider, anonymous.identityProvider.port], [false, null, idp.port]);
  assert.equal((await json(browser, "/_sim/api/status")).identityProvider.origin, idp.origin);

  // The platform's sign-in page lists the provider form (LocalLoginEnabled is false: no personas).
  const signInPage = await browser.request("/SignIn?returnUrl=%2Fmembers%2F");
  const html = await text(signInPage);
  assert.equal(signInPage.status, 200);
  assert.match(html, new RegExp(`<form action="/Account/Login/ExternalLogin\\?ReturnUrl=%2Fmembers%2F" method="post" class="paqvilo-mirage-provider"><input name="__RequestVerificationToken" type="hidden" value="${csrf}"><button name="provider" type="submit" class="btn btn-primary" value="https://idp.example.test/local/" title="Local IdP">Local IdP</button></form>`));
  assert.doesNotMatch(html, /paqvilo-mirage-persona/);
  const local = await browser.request("/SignIn", formBody({ contactId: "alex", ReturnUrl: "/" }));
  assert.equal(local.status, 400);
  assert.match(await text(local), /Local sign-in is turned off for this site/);

  const challenge = await startSignIn(browser, { returnUrl: "/members/#top" });
  assert.equal(challenge.headers.get("x-sim-route"), "external-login");
  const authorize = new URL(challenge.headers.get("location"));
  assert.equal(authorize.origin + authorize.pathname, `${idp.origin}/oidc-local/oauth2/authorize`);
  assert.deepEqual([...authorize.searchParams.keys()], ["client_id", "redirect_uri", "response_type", "scope", "state", "response_mode", "nonce", "ui_locales"]);
  const query = Object.fromEntries(authorize.searchParams);
  assert.deepEqual([query.client_id, query.redirect_uri, query.response_type, query.scope, query.response_mode, query.ui_locales], ["local-client", `${app.url}/`, "code id_token", "openid", "form_post", "en-US"]);
  assert.match(query.state, /^OpenIdConnect\.AuthenticationProperties=/);
  assert.match(query.nonce, /^\d+\.[\w-]+$/);
  const [nonceCookie] = challenge.headers.getSetCookie();
  assert.match(nonceCookie, /^OpenIdConnect\.nonce\.[\w-]+=N; Path=\/; HttpOnly; SameSite=Lax; Max-Age=3600$/);

  // The chooser lists active contacts only.
  const chooser = await text(await browser.request(authorize.href));
  assert.match(chooser, /data-contact-id="alex"/);
  assert.match(chooser, /data-contact-id="casey"/);
  assert.doesNotMatch(chooser, /data-contact-id="carol"/);
  const answer = await choose(browser, authorize.href, { contactId: "alex" });
  // The form post to the site root: validated, then the ExternalLoginCallback hop.
  const response = await postBack(browser, answer, idp.origin);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/Account/Login/ExternalLoginCallback?ReturnUrl=%2Fmembers%2F%23top");
  assert.ok(!browser.jar.has(nonceCookie.split("=")[0]), "the nonce cookie is used once");
  assert.ok(browser.jar.has(`paqvilo-mirage-external-${new URL(app.url).port}`));
  const callback = await browser.request(response.headers.get("location"));
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/members/#top");
  assert.equal(callback.headers.get("x-sim-route"), "external-sign-in");
  assert.ok(!browser.jar.has(`paqvilo-mirage-external-${new URL(app.url).port}`));
  assert.equal(field(await text(await browser.request("/members/")), "user"), "Alex Local");
  const session = await json(browser, "/_sim/api/session");
  assert.deepEqual([session.signedIn, session.contactId, session.provider?.id, session.provider?.name], [true, "alex", AUTHORITY, "Local"]);
  // The preset's identity was recorded at the provider (adx_externalidentity) and audited.
  const { identities } = await json(browser, "/_sim/api/session/identities");
  assert.equal(identities.length, 1);
  assert.deepEqual([identities[0].contactId, identities[0].provider, identities[0].providerName, identities[0].origin, identities[0].active], ["alex", AUTHORITY, "Local", "preset", true]);
  const sub = identities[0].username;
  assert.equal(claimsOf(hiddenFields(answer).id_token).sub, sub);
  const audit = await json(browser, "/_sim/api/audit?kind=external-identity");
  assert.equal(audit.items.length, 1);
  assert.deepEqual([audit.items[0].entity, audit.items[0].identity.contactId, audit.items[0].query.origin, audit.items[0].query.username], ["adx_externalidentity", "alex", "preset", sub]);
  // A second sign-in reuses the identity.
  const again = await signInThrough(client(app), idp, { contactId: "alex", returnUrl: "/" });
  assert.equal(again.headers.get("location"), "/");
  assert.equal((await json(browser, "/_sim/api/session/identities")).identities.length, 1);
  // The site's own forms post a Microsoft authority for the built-in provider only; others are refused.
  const token = /value="([^"]+)"/.exec(await text(await browser.request("/_layout/tokenhtml")))[1];
  const unknown = await browser.request("/Account/Login/ExternalLogin?returnUrl=%2F", formBody({ __RequestVerificationToken: token, provider: "https://login.windows.net/tenant/" }));
  assert.equal(unknown.status, 400);
  assert.match(await text(unknown), /is not an identity provider of this site/);
});

test("the provider's response is validated: state, nonce cookie, signature, reply path and replay; other posts to a reply URL pass through", async (t) => {
  const settings = [...LOCAL_PROVIDER, ["Authentication/OpenIdConnect/Other/Authority", "https://other.example.test/"], ["Authentication/OpenIdConnect/Other/RedirectUri", "/ajax/"]];
  const { app, idp } = await simulator(t, settings);
  const browser = client(app);
  const reject = async (response, message, code) => {
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("x-sim-route"), "sign-in-page");
    assert.match(await text(response), message);
    if (code) assert.ok((await json(browser, "/_sim/api/diagnostics")).diagnostics?.some?.((item) => item.code === code) ?? true);
  };
  // A forged state.
  await reject(
    await browser.request("/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: idp.origin, "sec-fetch-site": "same-site" }, body: new URLSearchParams({ state: "OpenIdConnect.AuthenticationProperties=forged.sig", id_token: "a.b.c" }) }),
    /does not carry a state this portal issued/,
  );
  // A browser that did not start the sign-in has no nonce cookie.
  const challenge = await startSignIn(browser);
  const answer = await choose(browser, challenge.headers.get("location"), { contactId: "blair" });
  const stranger = client(app);
  await reject(await postBack(stranger, answer, idp.origin), /no matching OpenIdConnect\.nonce cookie/);
  // A token whose payload was changed fails its signature.
  const fields = hiddenFields(answer);
  const [header, payload, signature] = fields.id_token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...claimsOf(fields.id_token), sub: "someone-else" })).toString("base64url");
  const tampered = answer.replace(fields.id_token, `${header}.${forged}.${signature}`);
  await reject(await postBack(browser, tampered, idp.origin), /The id_token signature is invalid\./);
  // The provider's answer posted to another provider's reply URL.
  const misplaced = answer.replace(`action="${app.url}/"`, `action="${app.url}/ajax/"`);
  await reject(await postBack(browser, misplaced, idp.origin), /not the provider&#39;s reply URL/);
  // The genuine answer signs in once; a replay has no nonce cookie any more.
  const accepted = await postBack(browser, answer, idp.origin);
  assert.equal(accepted.status, 302);
  await reject(await postBack(browser, answer, idp.origin), /no matching OpenIdConnect\.nonce cookie/);
  // Only the local identity provider's origin may post cross-origin, and only to a reply URL.
  const foreign = await browser.request("/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://127.0.0.1:9", "sec-fetch-site": "same-site" }, body: "state=x&id_token=a.b.c" });
  assert.equal(foreign.status, 403);
  const elsewhere = await browser.request("/members/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: idp.origin, "sec-fetch-site": "same-site" }, body: "a=1" });
  assert.equal(elsewhere.status, 403);
  // Other form posts to a reply URL are not provider responses: the page receives its body.
  const posted = await browser.request("/ajax/", formBody({ a: "kept" }));
  assert.equal(posted.status, 200);
  assert.equal(field(await text(posted), "posted"), "kept");
  // Query answers are read only for response_mode=query providers: here the home page renders.
  assert.equal((await client(app).request("/?state=x&id_token=a.b.c")).status, 200);
  const { app: queryApp, idp: queryIdp } = await simulator(t, [...LOCAL_PROVIDER, ["Authentication/OpenIdConnect/Local/ResponseMode", "query"]]);
  const viaQuery = client(queryApp);
  const queryChallenge = await startSignIn(viaQuery, { returnUrl: "/members/" });
  assert.equal(new URL(queryChallenge.headers.get("location")).searchParams.get("response_mode"), "query");
  const authorize = new URL(queryChallenge.headers.get("location"));
  authorize.searchParams.set("login_hint", "alex");
  const queryAnswer = await viaQuery.request(authorize.href, { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(queryAnswer.status, 302);
  const back = new URL(queryAnswer.headers.get("location"));
  assert.equal(back.origin + back.pathname, `${queryApp.url}/`);
  const queryResponse = await viaQuery.request(back.pathname + back.search, { headers: { "sec-fetch-site": "same-site" } });
  assert.equal(queryResponse.headers.get("location"), "/Account/Login/ExternalLoginCallback?ReturnUrl=%2Fmembers%2F");
  assert.equal((await viaQuery.request(queryResponse.headers.get("location"))).headers.get("location"), "/members/");
  assert.equal(queryIdp.providers[0].responseMode, "query");
  // ExternalLoginCallback without an external sign-in goes to the sign-in path.
  const missing = await client(app).request("/Account/Login/ExternalLoginCallback?ReturnUrl=%2Fmembers%2F");
  assert.equal(missing.status, 302);
  assert.equal(missing.headers.get("location"), "/signin?ReturnUrl=%2Fmembers%2F");
  // The anti-forgery token is required on ExternalLogin.
  const noToken = await client(app).request("/Account/Login/ExternalLogin?returnUrl=%2F", formBody({ provider: AUTHORITY }));
  assert.equal(noToken.status, 400);
  assert.match(await text(noToken), /The anti-forgery token is missing or invalid/);
});

test("a new user's first sign-in follows the registration settings: open registration, disabled registration, unique email and contact mapping with email", async (t) => {
  // Open registration (the documented defaults): the contact and its identity are created.
  {
    const { app, idp } = await simulator(t);
    const browser = client(app);
    const done = await signInThrough(browser, idp, { returnUrl: "/", newUser: { given_name: "Dana", family_name: "New", email: "dana@example.test" } });
    assert.equal(done.status, 302);
    assert.equal(done.headers.get("x-sim-route"), "external-sign-in-registration");
    const session = await json(browser, "/_sim/api/session");
    assert.equal(session.name, "Dana New");
    const contact = app.store.snapshot({ tables: ["contact"] }).tables.contact.find((row) => row.contactid === session.contactId);
    assert.deepEqual([contact.firstname, contact.lastname, contact.emailaddress1, contact.fullname], ["Dana", "New", "dana@example.test", "Dana New"]);
    const { identities, registrations } = await json(browser, "/_sim/api/session/identities");
    assert.deepEqual(identities.map((item) => [item.contactId, item.origin]), [[session.contactId, "registration"]]);
    assert.equal(registrations[0].kind, "registration");
    // The audit log and the _sim personas show what registration produced.
    const audit = (await json(browser, "/_sim/api/audit?kind=registration")).items;
    assert.deepEqual(audit.map((item) => item.entity).sort(), ["adx_externalidentity", "contact"]);
    assert.ok(audit.every((item) => item.identity.contactId === session.contactId && item.status === 201));
    const personas = await json(browser, "/_sim/api/personas");
    assert.ok(personas.personas.some((persona) => persona.contactId === session.contactId && persona.active));
    // RequireUniqueEmail (default true): an existing contact's email cannot register again.
    const taken = await signInThrough(client(app), idp, { newUser: { given_name: "Alex", family_name: "Again", email: "ALEX@example.test" } });
    assert.equal(taken.status, 409);
    assert.match(await text(taken), /Email already in use: ALEX@example\.test belongs to another contact/);
  }
  // Registration turned off: the RegistrationDisabledMessage snippet; contact mapping with email links existing contacts.
  {
    const settings = [...LOCAL_PROVIDER, ["Authentication/Registration/Enabled", "false"], ["Authentication/OpenIdConnect/Local/AllowContactMappingWithEmail", "true"]];
    const { app, idp } = await simulator(t, settings);
    const refused = await signInThrough(client(app), idp, { newUser: { given_name: "Eve", family_name: "Outside", email: "eve@example.test" } });
    assert.equal(refused.status, 403);
    assert.match(await text(refused), /<div class="alert alert-danger" role="alert">New accounts are closed\.<\/div>/);
    const browser = client(app);
    const mapped = await signInThrough(browser, idp, { returnUrl: "/members/", newUser: { given_name: "Alex", family_name: "Elsewhere", email: "alex@EXAMPLE.test" } });
    assert.equal(mapped.headers.get("location"), "/members/");
    assert.equal(mapped.headers.get("x-sim-route"), "external-sign-in-email-mapping");
    assert.equal((await json(browser, "/_sim/api/session")).contactId, "alex");
    const { identities } = await json(browser, "/_sim/api/session/identities");
    assert.deepEqual(identities.map((item) => [item.contactId, item.origin]), [["alex", "email-mapping"]]);
    assert.equal((await json(browser, "/_sim/api/audit?kind=external-identity")).items[0].query.origin, "email-mapping");
  }
  // The provider's RegistrationEnabled false, and an identity whose contact is inactive.
  {
    const settings = [...LOCAL_PROVIDER, ["Authentication/OpenIdConnect/Local/RegistrationEnabled", "false"]];
    const subject = presetSubject({ id: AUTHORITY }, "alex");
    const state = initialState({
      tables: { adx_externalidentity: [{ adx_externalidentityid: "identity-carol", adx_username: subject, adx_identityprovidername: AUTHORITY, adx_contactid: { id: "carol", logical_name: "contact" }, statecode: 0 }] },
      mappings: { adx_externalidentity: { entitySet: "adx_externalidentities", idColumn: "adx_externalidentityid", nameColumn: "adx_username" } },
    });
    const { app, idp } = await simulator(t, settings, state);
    const refused = await signInThrough(client(app), idp, { newUser: { given_name: "Fay", family_name: "New", email: "fay@example.test" } });
    assert.equal(refused.status, 403);
    assert.match(await text(refused), /New accounts are closed\./);
    // Alex's preset subject belongs to Carol's (inactive) contact in this data.
    const inactive = await signInThrough(client(app), idp, { contactId: "alex" });
    assert.equal(inactive.status, 403);
    assert.match(await text(inactive), /Invalid sign-in attempt\./);
  }
});

test("invitation codes register into the invited contact with its account and web roles; group invitations count redemptions", async (t) => {
  const settings = [...LOCAL_PROVIDER, ["Authentication/Registration/OpenRegistrationEnabled", "false"]];
  const invitations = [
    { adx_invitationid: "inv-single", adx_name: "Casey", adx_invitationcode: "WELCOME-CASEY", adx_type: 756150000, adx_invitecontact: { id: "casey", logical_name: "contact" }, adx_assigntoaccount: { id: "helios", logical_name: "account" }, adx_expirydate: "2099-12-31", statecode: 0, statuscode: 756150000 },
    { adx_invitationid: "inv-group", adx_name: "Team", adx_invitationcode: "TEAM", adx_type: { value: 756150001 }, adx_maximumredemptions: 1, adx_redemptions: 0, statecode: 0, statuscode: 1 },
    { adx_invitationid: "inv-old", adx_name: "Old", adx_invitationcode: "OLD", adx_type: 756150000, adx_invitecontact: { id: "casey", logical_name: "contact" }, adx_expirydate: "2020-01-01", statecode: 0, statuscode: 756150000 },
  ];
  const state = initialState({
    tables: { adx_invitation: invitations, adx_invitation_mspp_webrole_powerpagecomponent: [{ adx_invitationid: "inv-single", powerpagecomponentid: "reviewer" }] },
    mappings: { adx_invitation: { entitySet: "adx_invitations", idColumn: "adx_invitationid", nameColumn: "adx_name", relationships: {} } },
  });
  const { app, csrf, idp } = await simulator(t, settings, state);
  const invitation = (id) => app.store.snapshot({ tables: ["adx_invitation"] }).tables.adx_invitation.find((row) => row.adx_invitationid === id);
  // Without open registration, a new identity is sent to the invitation redemption page.
  const browser = client(app);
  const pending = await signInThrough(browser, idp, { returnUrl: "/members/", newUser: { given_name: "Casey", family_name: "Online", email: "casey.online@example.test" } });
  assert.equal(pending.status, 302);
  assert.equal(pending.headers.get("location"), "/Account/Login/RedeemInvitation?ReturnUrl=%2Fmembers%2F");
  const redeemPage = await browser.request(pending.headers.get("location"));
  assert.equal(redeemPage.status, 200);
  assert.equal(redeemPage.headers.get("x-sim-route"), "redeem-invitation");
  assert.match(await text(redeemPage), /Signed in with Local IdP as casey\.online@example\.test\. Enter your invitation code to finish registering\./);
  const redeem = (code, who = browser) => who.request("/Account/Login/RedeemInvitation?ReturnUrl=%2Fmembers%2F", formBody({ __RequestVerificationToken: csrf, InvitationCode: code }));
  for (const [code, message] of [["NOPE", /The invitation code is not valid\./], ["OLD", /The invitation has expired\./]]) {
    const refused = await redeem(code);
    assert.equal(refused.status, 400, code);
    assert.match(await text(refused), message);
  }
  const redeemed = await redeem("welcome-casey");
  assert.equal(redeemed.status, 302);
  assert.equal(redeemed.headers.get("location"), "/members/");
  assert.equal(redeemed.headers.get("x-sim-route"), "external-sign-in-invitation");
  const session = await json(browser, "/_sim/api/session");
  assert.deepEqual([session.contactId, session.accountId], ["casey", "helios"]);
  assert.ok(session.roles.includes("Reviewer"));
  const single = invitation("inv-single");
  assert.deepEqual([single.adx_redeemedcontact?.id, single.adx_redemptions, single.statuscode], ["casey", 1, 756150001]);
  assert.deepEqual((await json(browser, "/_sim/api/session/identities")).identities.map((item) => [item.contactId, item.origin, item.invitationId]), [["casey", "invitation", "inv-single"]]);
  const again = await signInThrough(client(app), idp, { newUser: { given_name: "Late", family_name: "Comer", email: "late@example.test" } });
  assert.equal(again.headers.get("location"), "/Account/Login/RedeemInvitation?ReturnUrl=%2F");
  // Redeem first: a valid code without a pending sign-in goes to the (only) provider, carrying the code.
  const first = client(app);
  assert.equal((await first.request("/Account/Login/RedeemInvitation?ReturnUrl=%2F&InvitationCode=TEAM")).status, 200);
  const toProvider = await redeem("TEAM", first);
  assert.equal(toProvider.status, 302);
  const authorize = new URL(toProvider.headers.get("location"));
  assert.equal(authorize.origin, idp.origin);
  const answer = await choose(first, authorize.href, { newUser: { given_name: "Gail", family_name: "Group", email: "gail@example.test" } });
  const response = await postBack(first, answer, idp.origin);
  assert.equal(response.headers.get("location"), "/Account/Login/ExternalLoginCallback?ReturnUrl=%2Fmembers%2F&InvitationCode=TEAM");
  const joined = await first.request(response.headers.get("location"));
  assert.equal(joined.headers.get("x-sim-route"), "external-sign-in-invitation");
  assert.equal((await json(first, "/_sim/api/session")).name, "Gail Group");
  const group = invitation("inv-group");
  assert.deepEqual([group.adx_redemptions, group.statuscode], [1, 756150001]);
  // The group invitation's one redemption is used up.
  const later = client(app);
  await signInThrough(later, idp, { newUser: { given_name: "Hal", family_name: "Late", email: "hal@example.test" } });
  const full = await redeem("TEAM", later);
  assert.equal(full.status, 400);
  assert.match(await text(full), /The invitation has reached its maximum number of redemptions\./);
  // Registration turned off: redemption is refused with the RegistrationDisabledMessage snippet.
  const { app: closedApp } = await simulator(t, [...settings, ["Authentication/Registration/Enabled", "false"]], initialState());
  const disabled = await client(closedApp).request("/Account/Login/RedeemInvitation");
  assert.equal(disabled.status, 403);
  assert.match(await text(disabled), /New accounts are closed\./);
});

test("LoginButtonAuthenticationType sends the sign-in page to its provider; LogOff runs the provider's end-session when external logout is on", async (t) => {
  const settings = [
    ...LOCAL_PROVIDER,
    ["Authentication/Registration/LoginButtonAuthenticationType", AUTHORITY],
    ["Authentication/OpenIdConnect/Local/ExternalLogoutEnabled", "true"],
  ];
  const { app, idp } = await simulator(t, settings);
  assert.equal(idp.providers[0].default, true);
  const browser = client(app);
  const direct = await browser.request("/SignIn?returnUrl=%2Fmembers%2F");
  assert.equal(direct.status, 302);
  assert.equal(direct.headers.get("x-sim-route"), "external-login");
  assert.equal(new URL(direct.headers.get("location")).origin, idp.origin);
  // The ExternalLogin and Register paths still render the sign-in page.
  assert.equal((await browser.request("/Account/Login/ExternalLogin")).status, 200);
  const answer = await choose(browser, direct.headers.get("location"), { contactId: "alex" });
  const response = await postBack(browser, answer, idp.origin);
  assert.equal((await browser.request(response.headers.get("location"))).headers.get("location"), "/members/");
  // LogOff: local sign-out, then the provider's end-session with the return URL (fragment kept).
  const logOff = await browser.request("/Account/Login/LogOff?returnUrl=%2F_sim%2F%23access");
  assert.equal(logOff.status, 302);
  assert.equal(logOff.headers.get("x-sim-route"), "sign-out-external");
  const endSession = new URL(logOff.headers.get("location"));
  assert.equal(endSession.origin + endSession.pathname, `${idp.origin}/oidc-local/oauth2/logout`);
  assert.equal(endSession.searchParams.get("post_logout_redirect_uri"), `${app.url}/_sim/#access`);
  assert.equal((await json(browser, "/_sim/api/session")).signedIn, false);
  const back = await browser.request(endSession.href);
  assert.equal(back.status, 302);
  assert.equal(back.headers.get("location"), `${app.url}/_sim/#access`);
  const anonymous = await browser.request("/Account/Login/LogOff?returnUrl=%2F");
  assert.equal(anonymous.headers.get("location"), "/signin?ReturnUrl=%2FAccount%2FLogin%2FLogOff");
  // A configured PostLogoutRedirectUri is followed on the local origin.
  const { app: other, idp: otherIdp } = await simulator(t, [...LOCAL_PROVIDER, ["Authentication/OpenIdConnect/Local/ExternalLogoutEnabled", "true"], ["Authentication/OpenIdConnect/Local/PostLogoutRedirectUri", "https://portal.example.com/signed-out/?x=1"]]);
  const second = client(other);
  await signInThrough(second, otherIdp, { contactId: "blair" });
  const out = new URL((await second.request("/Account/Login/LogOff?returnUrl=%2F")).headers.get("location"));
  assert.equal(out.searchParams.get("post_logout_redirect_uri"), `${other.url}/signed-out/?x=1`);
  // Without external logout, LogOff returns to the return URL directly.
  const { app: plain, idp: plainIdp } = await simulator(t);
  const third = client(plain);
  await signInThrough(third, plainIdp, { contactId: "alex" });
  const direct2 = await third.request("/Account/Login/LogOff?returnUrl=%2Fmembers%2F");
  assert.deepEqual([direct2.headers.get("location"), direct2.headers.get("x-sim-route")], ["/members/", "sign-out"]);
});

test("the session roles override needs a signed-in browser and known web roles; the identity provider closes with its runtime", async (t) => {
  const { app, csrf, idp, close } = await simulator(t);
  const browser = client(app);
  const roles = (body, headers = { "x-sim-csrf": csrf }) => browser.request("/_sim/api/session/roles", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await roles({ roles: ["Member"] }, {})).status, 403);
  const anonymous = await roles({ roles: ["Member"] });
  assert.equal(anonymous.status, 409);
  assert.equal(anonymous.headers.get("set-cookie"), null, "never creates a session");
  await signInThrough(browser, idp, { contactId: "blair" });
  assert.equal((await roles({ roles: ["Nobody"] })).status, 400);
  assert.equal((await roles({ roles: "Member" })).status, 400);
  const override = await roles({ roles: ["Member", "Member"] });
  assert.equal(override.status, 200);
  const overridden = await override.json();
  assert.deepEqual([overridden.contactId, overridden.roles, overridden.roleSource, overridden.provider?.name], ["blair", ["Member"], "override", "Local"]);
  assert.equal(field(await text(await browser.request("/members/")), "user"), "Blair Local");
  const cleared = await (await roles({ roles: null })).json();
  assert.deepEqual([cleared.roleSource, cleared.provider?.name], ["memberships", "Local"]);
  assert.equal((await browser.request("/members/")).status, 403);
  const origin = idp.origin;
  assert.equal((await fetch(`${origin}/`)).status, 200);
  await close();
  await assert.rejects(fetch(`${origin}/`));
});
