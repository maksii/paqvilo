import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createSimulator } from "../server.mjs";
import { contactFieldsFromClaims, externalProviders, oidcOptions } from "../lib/external-login.mjs";
import { startIdentityProvider } from "../lib/identity-provider.mjs";

// The authorization code flow and the request options of an OpenID Connect provider (Learn,
// "Set up an OpenID Connect provider"; lib/identity-provider.mjs, lib/sign-in-flow.mjs).

const decode = (value) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const hiddenFields = (html) => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(([, name, value]) => [name, decode(value)]));
const formBody = (fields) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
const claimsOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
const leftHash = (value) => createHash("sha256").update(value).digest().subarray(0, 16).toString("base64url");
const settingsPortal = (entries) => ({ settings: Object.fromEntries(entries), templates: {}, snippets: {}, pages: [] });

test("OpenID Connect options and userinfo claim mappings come from the documented site settings", () => {
  assert.deepEqual(oidcOptions({}), { clientSecret: null, tokenAuthMethod: "client_secret_post", certificateKid: null, useUserInfo: false, userInfoEndpoint: null, prompt: null, acrValues: null, dynamicParameters: [], problems: [] });
  const options = oidcOptions({
    ClientSecret: "s3cret",
    TokenEndPointAuthenticatedMethod: "Private_Key_JWT",
    "PrivateKeyJwt/CertificateObject": '{"kid":"ABC123"}',
    useuserinfoendpointforclaims: "True",
    UserInfoEndpoint: "https://idp.example.test/userinfo",
    Prompt: "Select_Account",
    AcrValues: "mfa phr",
    AllowedDynamicAuthorizationParameters: " tenant_hint, region ,, bad name",
  });
  assert.deepEqual(
    [options.clientSecret, options.tokenAuthMethod, options.certificateKid, options.useUserInfo, options.userInfoEndpoint, options.prompt, options.acrValues, options.dynamicParameters],
    ["s3cret", "private_key_jwt", "ABC123", true, "https://idp.example.test/userinfo", "select_account", "mfa phr", ["tenant_hint", "region"]],
  );
  assert.deepEqual(options.problems, ['AllowedDynamicAuthorizationParameters lists "bad name", which is not a parameter name.']);
  const wrong = oidcOptions({ TokenEndPointAuthenticatedMethod: "client_secret_basic", "PrivateKeyJwt/CertificateObject": "ABC123", Prompt: "always" });
  assert.equal(wrong.tokenAuthMethod, "client_secret_post");
  assert.equal(wrong.prompt, null);
  assert.equal(wrong.problems.length, 3);
  assert.match(oidcOptions({ "PrivateKeyJwt/CertificateObject": '{"thumbprint":"x"}' }).problems[0], /must be \{"kid":"<certificate thumbprint>"\}/);
  // The provider list carries them; OAuth 2.0 providers keep the defaults.
  const [oidc, oauth] = externalProviders(
    settingsPortal([
      ["Authentication/OpenIdConnect/Code/Authority", "https://idp.example.test/"],
      ["Authentication/OpenIdConnect/Code/ResponseType", "code"],
      ["Authentication/OpenIdConnect/Code/ClientSecret", "s3cret"],
      ["Authentication/OpenIdConnect/Code/UseUserInfoEndpointforClaims", "true"],
      ["Authentication/OpenAuth/Google/ClientId", "google"],
    ]),
  );
  assert.deepEqual([oidc.responseType, oidc.clientSecret, oidc.useUserInfo, oauth.tokenAuthMethod, oauth.useUserInfo], ["code", "s3cret", true, "client_secret_post", false]);
  // "field = userinfo.claim" reads the UserInfo response, and is ignored without one.
  const mapping = "firstname = given_name, telephone1 = userinfo.phone_number, emailaddress1=userinfo.email";
  assert.deepEqual(contactFieldsFromClaims({ given_name: "Ada" }, mapping, { userinfo: { phone_number: "+1 555", email: "ada@example.test" } }), { firstname: "Ada", telephone1: "+1 555", emailaddress1: "ada@example.test" });
  assert.deepEqual(contactFieldsFromClaims({ given_name: "Ada", phone_number: "+9" }, mapping), { firstname: "Ada" });
});

// ---- the local identity provider ----

const PORTAL = "http://127.0.0.1:9";
const USERS = [{ contactId: "alex", subject: "sub-alex", name: "Alex Local", givenName: "Alex", familyName: "Local", email: "alex@example.test", phone: "+1 555 0100" }];
async function provider(t, registration) {
  const client = { slug: "oidc-code", key: "Code", caption: "Code", clientId: "code-client", redirectUri: `${PORTAL}/`, ...registration };
  const idp = await startIdentityProvider({ providers: () => [client], users: async () => USERS });
  t.after(() => idp.close());
  const authority = idp.authority(client);
  const discovery = await (await fetch(`${authority}.well-known/openid-configuration`)).json();
  const base = { client_id: "code-client", redirect_uri: `${PORTAL}/`, response_type: "code", scope: "openid profile", state: "s-1", response_mode: "query", nonce: "n-1", login_hint: "alex" };
  /** The authorize request's answer: the redirect's parameters (query) or the posted fields. */
  const authorize = async (extra = {}, init = {}) => {
    const response = await fetch(`${discovery.authorization_endpoint}?${new URLSearchParams({ ...base, ...extra })}`, { redirect: "manual", ...init });
    if (response.status === 302) return Object.fromEntries(new URL(response.headers.get("location")).searchParams);
    return { status: response.status, html: await response.text(), cookie: response.headers.get("set-cookie") };
  };
  const tokenRequest = (fields) => fetch(discovery.token_endpoint, formBody({ grant_type: "authorization_code", redirect_uri: `${PORTAL}/`, client_id: "code-client", ...fields }));
  return { idp, authority, discovery, authorize, tokenRequest };
}

test("the identity provider redeems authorization codes with client_secret_post and PKCE, and serves UserInfo", async (t) => {
  const { authority, discovery, authorize, tokenRequest } = await provider(t, { clientSecret: "s3cret" });
  assert.deepEqual(
    [discovery.token_endpoint, discovery.userinfo_endpoint, discovery.token_endpoint_auth_methods_supported, discovery.code_challenge_methods_supported, discovery.prompt_values_supported, discovery.response_types_supported],
    [`${authority}oauth2/token`, `${authority}openid/userinfo`, ["client_secret_post", "private_key_jwt"], ["S256", "plain"], ["none", "login", "consent", "select_account", "create"], ["code", "id_token", "code id_token", "id_token token", "code id_token token"]],
  );
  // response_type=code: the redirect carries the code and state, never a token.
  const answered = await authorize();
  assert.deepEqual(Object.keys(answered), ["code", "state"]);
  assert.equal((await tokenRequest({ code: answered.code, grant_type: "password" }).then((r) => r.json())).error, "unsupported_grant_type");
  const badSecret = await tokenRequest({ code: answered.code, client_secret: "wrong" });
  assert.deepEqual([badSecret.status, (await badSecret.json()).error], [401, "invalid_client"]);
  const redeemed = await tokenRequest({ code: answered.code, client_secret: "s3cret" });
  assert.equal(redeemed.status, 200);
  const tokens = await redeemed.json();
  assert.deepEqual([tokens.token_type, tokens.expires_in, tokens.scope], ["Bearer", 3600, "openid profile"]);
  const claims = claimsOf(tokens.id_token);
  assert.deepEqual([claims.iss, claims.aud, claims.sub, claims.nonce, claims.at_hash, claims.c_hash], [authority, "code-client", "sub-alex", "n-1", leftHash(tokens.access_token), undefined]);
  assert.equal(claims.phone_number, undefined, "the phone number is a UserInfo claim only");
  // A code is redeemed once; the redirect URI must be the one it was issued for.
  const again = await tokenRequest({ code: answered.code, client_secret: "s3cret" });
  assert.deepEqual([again.status, (await again.json()).error], [400, "invalid_grant"]);
  const other = await authorize();
  assert.match((await (await tokenRequest({ code: other.code, client_secret: "s3cret", redirect_uri: `${PORTAL}/elsewhere` })).json()).error_description, /not the one the code was issued for/);
  // UserInfo: the Bearer access token reads the profile and the phone number.
  const info = await fetch(discovery.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  assert.deepEqual(await info.json(), { sub: "sub-alex", name: "Alex Local", given_name: "Alex", family_name: "Local", email: "alex@example.test", email_verified: true, preferred_username: "alex@example.test", phone_number: "+1 555 0100" });
  for (const authorization of [undefined, "Bearer unknown"]) {
    const refused = await fetch(discovery.userinfo_endpoint, { headers: authorization ? { authorization } : {} });
    assert.equal(refused.status, 401);
    assert.equal(refused.headers.get("www-authenticate"), 'Bearer error="invalid_token"');
  }
  // PKCE (RFC 7636): S256 and plain; a missing or wrong verifier is refused.
  const verifier = "v".repeat(43) + "-._~";
  const s256 = await authorize({ code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
  assert.match((await (await tokenRequest({ code: s256.code, client_secret: "s3cret" })).json()).error_description, /code_verifier is missing/);
  const s256b = await authorize({ code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
  assert.match((await (await tokenRequest({ code: s256b.code, client_secret: "s3cret", code_verifier: "w".repeat(43) })).json()).error_description, /does not match the code_challenge/);
  const s256c = await authorize({ code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
  assert.equal((await tokenRequest({ code: s256c.code, client_secret: "s3cret", code_verifier: verifier })).status, 200);
  const plain = await authorize({ code_challenge: verifier });
  assert.equal((await tokenRequest({ code: plain.code, client_secret: "s3cret", code_verifier: verifier })).status, 200);
  // A client without a registered secret cannot redeem with client_secret_post.
  const { authorize: unregisteredAuthorize, tokenRequest: unregisteredToken } = await provider(t, {});
  const unregistered = await (await unregisteredToken({ code: (await unregisteredAuthorize()).code, client_secret: "" })).json();
  assert.deepEqual([unregistered.error, unregistered.error_description], ["invalid_client", "No client secret is registered for this client: set the provider's ClientSecret site setting."]);
});

test("the identity provider answers every documented response type, prompt and acr_values, and shows custom parameters", async (t) => {
  const { authority, authorize } = await provider(t, { clientSecret: "s3cret" });
  // Front-channel access tokens come with at_hash; codes with c_hash.
  const implicit = await authorize({ response_type: "id_token token" });
  assert.deepEqual(Object.keys(implicit), ["access_token", "token_type", "expires_in", "id_token", "state"]);
  assert.equal(claimsOf(implicit.id_token).at_hash, leftHash(implicit.access_token));
  const hybrid = await authorize({ response_type: "code id_token token" });
  assert.deepEqual(Object.keys(hybrid), ["code", "access_token", "token_type", "expires_in", "id_token", "state"]);
  assert.deepEqual([claimsOf(hybrid.id_token).c_hash, claimsOf(hybrid.id_token).at_hash], [leftHash(hybrid.code), leftHash(hybrid.access_token)]);
  // A nonce is optional for the code flow only.
  assert.deepEqual(Object.keys(await authorize({ nonce: "" })), ["code", "state"]);
  assert.equal((await authorize({ response_type: "code id_token", nonce: "" })).status, 400);
  // acr_values: the answer's acr claim.
  assert.equal(claimsOf((await authorize({ response_type: "id_token", acr_values: "mfa phr" })).id_token).acr, "mfa");
  // prompt=none: login_hint, or this browser's provider session, else login_required.
  const silent = await authorize({ prompt: "none", response_type: "id_token" });
  assert.equal(claimsOf(silent.id_token).sub, "sub-alex");
  assert.deepEqual(await authorize({ prompt: "none", login_hint: "" }), { error: "login_required", error_description: "prompt=none: no user is signed in to the local identity provider in this browser and login_hint names no preset user.", state: "s-1" });
  const interactive = await fetch(`${authority}oauth2/authorize?${new URLSearchParams({ client_id: "code-client", redirect_uri: `${PORTAL}/`, response_type: "code", scope: "openid", state: "s-2", response_mode: "query", nonce: "n-2" })}`, { redirect: "manual" });
  const chooser = await interactive.text();
  const answer = await fetch(`${authority}oauth2/authorize`, { ...formBody({ ...hiddenFields(chooser), subject: "sub-alex" }), redirect: "manual" });
  const cookie = answer.headers.get("set-cookie").split(";")[0];
  const remembered = await authorize({ prompt: "none", login_hint: "" }, { headers: { cookie } });
  assert.deepEqual(Object.keys(remembered), ["code", "state"]);
  // prompt=login, select_account, consent and create always show the page, even with a hint.
  for (const value of ["login", "select_account", "consent", "create"]) {
    const page = await authorize({ prompt: value });
    assert.equal(page.status, 200, value);
    assert.match(page.html, new RegExp(`id="paqvilo-mirage-idp-prompt">${value}<`));
  }
  const create = (await authorize({ prompt: "create" })).html;
  assert.ok(create.indexOf('id="paqvilo-mirage-idp-create"') < create.indexOf('aria-label="Preset users"'), "prompt=create puts the sign-up form first");
  assert.match((await authorize({ prompt: "consent" })).html, /asks for consent to the scope openid profile/);
  // Custom authorization parameters are shown and travel with the chooser's forms.
  const custom = (await authorize({ prompt: "login", tenant_hint: "contoso", region: "eu" })).html;
  assert.match(custom, /<dd class="paqvilo-mirage-idp-extra" data-name="tenant_hint">contoso<\/dd>/);
  assert.equal(hiddenFields(custom).region, "eu");
  // A new user may give a phone number, a UserInfo claim.
  const newUser = await fetch(`${authority}oauth2/authorize`, { ...formBody({ ...hiddenFields(custom), subject: "new", given_name: "Nia", family_name: "New", email: "nia@example.test", phone_number: "+44 20" }), redirect: "manual" });
  assert.ok(new URL(newUser.headers.get("location")).searchParams.get("code"));
});

test("private_key_jwt: the token endpoint accepts client assertions signed with the registered key only", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const intruder = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const { authorize, tokenRequest, discovery } = await provider(t, { tokenAuthMethod: "private_key_jwt", clientKeys: [{ ...publicKey.export({ format: "jwk" }), kid: "THUMBPRINT" }] });
  const assertion = ({ kid = "THUMBPRINT", key = privateKey, claims = {} } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ iss: "code-client", sub: "code-client", aud: discovery.token_endpoint, jti: randomUUID(), iat: now, exp: now + 300, ...claims })).toString("base64url");
    return `${header}.${body}.${sign("sha256", Buffer.from(`${header}.${body}`), key).toString("base64url")}`;
  };
  const redeem = async (fields) => {
    const response = await tokenRequest({ code: (await authorize()).code, ...fields });
    return { status: response.status, body: await response.json() };
  };
  const jwtBearer = (value) => ({ client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: value });
  assert.equal((await redeem(jwtBearer(assertion()))).status, 200);
  const cases = [
    [{ client_secret: "s3cret" }, /registered for private_key_jwt/],
    [jwtBearer(assertion({ kid: "OTHER" })), /not signed with a registered key \(kid "OTHER"\)/],
    [jwtBearer(assertion({ key: intruder.privateKey })), /signature is invalid/],
    [jwtBearer(assertion({ claims: { aud: "https://elsewhere.example/" } })), /audience is not this token endpoint/],
    [jwtBearer(assertion({ claims: { exp: Math.floor(Date.now() / 1000) - 600 } })), /has expired/],
    [jwtBearer(assertion({ claims: { iss: "someone" } })), /iss and sub must be the client_id/],
  ];
  for (const [fields, message] of cases) {
    const result = await redeem(fields);
    assert.deepEqual([result.status, result.body.error], [401, "invalid_client"], String(message));
    assert.match(result.body.error_description, message);
  }
  // A client assertion is used once (jti).
  const once = assertion();
  assert.equal((await redeem(jwtBearer(once))).status, 200);
  assert.match((await redeem(jwtBearer(once))).body.error_description, /already used \(jti replay\)/);
});

// ---- the portal side ----

const AUTHORITY = "https://idp.example.test/code/";
const page = (id, name, partial, parent = "home") => [`adx_webpageid: ${id}`, `adx_name: ${name}`, `adx_partialurl: ${partial}`, ...(parent ? [`adx_parentpageid: ${parent}`] : []), "adx_pagetemplateid: main"].join("\n");
function portalFiles(settings) {
  return {
    "website.yml": "adx_name: Code Flow Site\nadx_websiteid: site\nadx_defaultlanguage: lang-en\nadx_website_language: 1033",
    "websitelanguage.yml": "- adx_websitelanguageid: lang-en\n  adx_name: English",
    "web-pages/home/Home.webpage.yml": page("home", "Home", "/", null),
    "page-templates/Main.pagetemplate.yml": "adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false",
    "web-templates/Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
    "web-templates/Main.webtemplate.source.html": '<p id="user">{% if user %}{{ user.fullname }}{% else %}anonymous{% endif %}</p>',
    "webrole.yml": "- adx_webroleid: signedin\n  adx_name: Authenticated Users\n  adx_authenticatedusersrole: true",
    "sitesetting.yml": settings.map(([name, value], index) => `- adx_sitesettingid: s${index}\n  adx_name: ${name}\n  adx_value: '${String(value).replace(/'/g, "''")}'`).join("\n"),
  };
}
const CODE_PROVIDER = [
  ["Authentication/Registration/ExternalLoginEnabled", "true"],
  ["Authentication/Registration/LocalLoginEnabled", "false"],
  ["Authentication/OpenIdConnect/Code/Authority", AUTHORITY],
  ["Authentication/OpenIdConnect/Code/ClientId", "code-client"],
  ["Authentication/OpenIdConnect/Code/ClientSecret", "s3cret"],
  ["Authentication/OpenIdConnect/Code/ResponseType", "code"],
  ["Authentication/OpenIdConnect/Code/ResponseMode", "query"],
];
const initial = () => ({
  version: 1,
  mappings: { contact: { entitySet: "contacts", idColumn: "contactid", nameColumn: "fullname" } },
  tables: { contact: [{ contactid: "alex", fullname: "Alex Local", firstname: "Alex", lastname: "Local", emailaddress1: "alex@example.test", telephone1: "+1 555 0100", statecode: 0 }] },
  permissions: [],
  settings: { permissionMode: "permissive" },
  simulator: { mode: "local", pageMode: "local", identity: { contactId: null, roleSource: "memberships", roles: [] }, live: { allowWrites: false }, endpoints: [] },
});
async function portal(t, settings) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-code-flow-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(portalFiles(settings))) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, "state.json"), port: 0, watch: false, initial: initial() });
  t.after(() => app.close());
  const jar = new Map();
  const request = async (target, { headers = {}, ...init } = {}) => {
    const response = await fetch(new URL(target, app.url), { redirect: "manual", ...init, headers: { "sec-fetch-site": "same-origin", ...(jar.size ? { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") } : {}), ...headers } });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const index = pair.indexOf("=");
      if (/;\s*max-age=0/i.test(line)) jar.delete(pair.slice(0, index));
      else jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  };
  /** POST ExternalLogin (the provider form), with query-string parameters; returns the authorize URL. */
  const startSignIn = async (query = "", provider = AUTHORITY) => {
    const token = /value="([^"]+)"/.exec(await (await request("/_layout/tokenhtml")).text())[1];
    const response = await request(`/Account/Login/ExternalLogin?returnUrl=%2F${query}`, formBody({ __RequestVerificationToken: token, provider }));
    assert.equal(response.status, 302, await response.clone().text());
    return new URL(response.headers.get("location"));
  };
  /** The chooser's choice, then the provider's answer delivered to the reply URL; returns the reply response. */
  const finish = async (authorize, choice = { subject: null, contactId: "alex" }) => {
    const chooser = await (await request(authorize.href, { headers: { "sec-fetch-site": "cross-site" } })).text();
    const subject = choice.contactId ? new RegExp(`data-subject="([^"]+)" data-contact-id="${choice.contactId}"`).exec(chooser)[1] : "new";
    const answer = await request(authorize.origin + authorize.pathname, formBody({ ...hiddenFields(chooser), subject, ...(choice.newUser ?? {}) }));
    if (answer.status === 302) return request(answer.headers.get("location"));
    const html = await answer.text();
    const action = decode(/<form method="post" action="([^"]+)">/.exec(html)[1]);
    return request(action, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: authorize.origin, "sec-fetch-site": "same-site" }, body: new URLSearchParams(hiddenFields(html)) });
  };
  const signedIn = async () => /<p id="user">([^<]*)</.exec(await (await request("/")).text())[1];
  const status = async () => (await (await request("/__sim/api/status")).json());
  return { app, request, startSignIn, finish, signedIn, status };
}

test("the authorization code flow redeems the code with client_secret_post and PKCE, and maps UserInfo claims", async (t) => {
  const settings = [
    ...CODE_PROVIDER,
    ["Authentication/OpenIdConnect/Code/UseUserInfoEndpointforClaims", "true"],
    ["Authentication/OpenIdConnect/Code/RegistrationClaimsMapping", "firstname=given_name,lastname=family_name,emailaddress1=email,telephone1=userinfo.phone_number"],
    ["Authentication/OpenIdConnect/Code/LoginClaimsMapping", "mobilephone=userinfo.phone_number"],
  ];
  const { request, startSignIn, finish, signedIn, status } = await portal(t, settings);
  const authorize = await startSignIn();
  const query = Object.fromEntries(authorize.searchParams);
  assert.deepEqual([query.response_type, query.response_mode, query.code_challenge_method], ["code", "query", "S256"]);
  assert.match(query.code_challenge, /^[\w-]{43}$/);
  // The state is encrypted: the PKCE verifier and the return URL never show in a URL.
  assert.doesNotMatch(Buffer.from(query.state.slice("OpenIdConnect.AuthenticationProperties=".length), "base64url").toString("latin1"), /"v"|"r"|returnUrl/);
  const reply = await finish(authorize);
  // The provider's redirect to the reply URL carries the code only; the portal redeems it.
  assert.equal(reply.status, 302, await reply.clone().text());
  assert.equal(reply.headers.get("x-sim-route"), "external-login-response");
  const callback = await request(reply.headers.get("location"));
  assert.equal(callback.headers.get("x-sim-route"), "external-sign-in");
  assert.equal(await signedIn(), "Alex Local");
  // LoginClaimsMapping read the UserInfo phone number into the contact.
  const contacts = (await (await request("/__sim/api/state")).json()).data.contact;
  assert.equal(contacts.find((row) => row.contactid === "alex").mobilephone, "+1 555 0100");
  // A new user's registration maps its UserInfo phone number.
  await request("/Account/Login/LogOff?returnUrl=%2F");
  const registration = await finish(await startSignIn(), { newUser: { given_name: "Nia", family_name: "New", email: "nia@example.test", phone_number: "+44 20 7946 0000" } });
  assert.equal((await request(registration.headers.get("location"))).headers.get("x-sim-route"), "external-sign-in-registration");
  assert.equal(await signedIn(), "Nia New");
  const nia = (await (await request("/__sim/api/state")).json()).data.contact.find((row) => row.emailaddress1 === "nia@example.test");
  assert.deepEqual([nia.firstname, nia.lastname, nia.telephone1], ["Nia", "New", "+44 20 7946 0000"]);
  const provider = (await status()).identityProvider.providers[0];
  assert.deepEqual(
    [provider.flow, provider.pkce, provider.clientSecret, provider.tokenAuthMethod, provider.userInfo],
    ["authorization-code", true, "configured", "client_secret_post", { enabled: true, endpoint: null, localEndpoint: true }],
  );
  assert.ok(!JSON.stringify(await status()).includes("s3cret"), "the client secret is never reported");
});

test("without UseUserInfoEndpointforClaims userinfo mappings are ignored; a refused code or a missing secret fails the sign-in", async (t) => {
  const settings = [...CODE_PROVIDER.filter(([name]) => !name.endsWith("/ClientSecret")), ["Authentication/OpenIdConnect/Code/RegistrationClaimsMapping", "firstname=given_name,lastname=family_name,telephone1=userinfo.phone_number"]];
  const missingSecret = await portal(t, settings);
  const failed = await missingSecret.finish(await missingSecret.startSignIn());
  assert.equal(failed.status, 502);
  assert.match(await failed.text(), /The identity provider refused the authorization code \(invalid_client: No client secret is registered for this client: set the provider&#39;s ClientSecret site setting\.\)/);
  assert.equal((await missingSecret.status()).diagnostics.byCode.EXTERNAL_LOGIN_TOKEN_REQUEST_FAILED, 1);
  const withSecret = await portal(t, [...settings, ["Authentication/OpenIdConnect/Code/ClientSecret", "s3cret"]]);
  const registration = await withSecret.finish(await withSecret.startSignIn(), { newUser: { given_name: "Nia", family_name: "New", email: "nia@example.test", phone_number: "+44 20" } });
  await withSecret.request(registration.headers.get("location"));
  const nia = (await (await withSecret.request("/__sim/api/state")).json()).data.contact.find((row) => row.firstname === "Nia");
  assert.deepEqual([nia.lastname, nia.telephone1], ["New", undefined]);
  // A code that is not the provider's is refused at the token endpoint.
  const authorize = await withSecret.startSignIn();
  const state = authorize.searchParams.get("state");
  const forged = await withSecret.request(`/?${new URLSearchParams({ code: "forged", state })}`);
  assert.equal(forged.status, 502);
  assert.match(await forged.text(), /refused the authorization code \(invalid_grant: The authorization code is unknown\.\)/);
});

test("private_key_jwt signs the client assertion with the local stand-in for the site's certificate; a missing certificate fails", async (t) => {
  const settings = [...CODE_PROVIDER.filter(([name]) => !name.endsWith("/ClientSecret")), ["Authentication/OpenIdConnect/Code/TokenEndPointAuthenticatedMethod", "private_key_jwt"]];
  const withCertificate = await portal(t, [...settings, ["Authentication/OpenIdConnect/Code/PrivateKeyJwt/CertificateObject", '{"kid":"A1B2C3D4E5"}']]);
  const reply = await withCertificate.finish(await withCertificate.startSignIn());
  assert.equal(reply.status, 302, await reply.clone().text());
  await withCertificate.request(reply.headers.get("location"));
  assert.equal(await withCertificate.signedIn(), "Alex Local");
  const provider = (await withCertificate.status()).identityProvider.providers[0];
  assert.deepEqual([provider.tokenAuthMethod, provider.certificateKid, provider.clientSecret], ["private_key_jwt", "A1B2C3D4E5", null]);
  const without = await portal(t, settings);
  const failed = await without.finish(await without.startSignIn());
  assert.equal(failed.status, 500);
  assert.match(await failed.text(), /PrivateKeyJwt\/CertificateObject names no certificate/);
  assert.equal((await without.status()).diagnostics.byCode.EXTERNAL_LOGIN_CERTIFICATE_MISSING, 1);
});

test("UserInfo problems are warnings and sign-in continues: unreachable, unauthorized, no access token; an online endpoint is answered locally", async (t) => {
  const userinfo = (endpoint) => [["Authentication/OpenIdConnect/Code/UseUserInfoEndpointforClaims", "true"], ...(endpoint ? [["Authentication/OpenIdConnect/Code/UserInfoEndpoint", endpoint]] : [])];
  const warnedWith = async (settings, code, message) => {
    const site = await portal(t, settings);
    const reply = await site.finish(await site.startSignIn());
    assert.equal(reply.status, 302, await reply.clone().text());
    await site.request(reply.headers.get("location"));
    assert.equal(await site.signedIn(), "Alex Local", code);
    const { diagnostics } = await site.status();
    assert.equal(diagnostics.byCode[code], 1, code);
    const recorded = (await (await site.request("/__sim/api/diagnostics")).json()).diagnostics.find((item) => item.code === code);
    assert.equal(recorded.severity, "warning");
    assert.match(recorded.message, message);
    return site;
  };
  await warnedWith([...CODE_PROVIDER, ...userinfo("http://127.0.0.1:9/userinfo")], "USERINFO_UNAVAILABLE", /is not reachable[\s\S]*Sign-in continues without UserInfo claims/);
  // Another provider's endpoint on the local identity provider does not know this access token: 401.
  const twoProviders = [
    ...CODE_PROVIDER,
    ["Authentication/OpenIdConnect/Other/Authority", "https://other.example.test/"],
    ["Authentication/OpenIdConnect/Other/ClientId", "other-client"],
  ];
  const probe = await portal(t, twoProviders);
  const otherAuthority = (await probe.status()).identityProvider.providers.find((item) => item.name === "Other").localAuthority;
  await warnedWith([...twoProviders, ...userinfo(`${otherAuthority}openid/userinfo`)], "USERINFO_UNAUTHORIZED", /answered 401 invalid_token/);
  // The hybrid flow has no access token for UserInfo.
  await warnedWith([...CODE_PROVIDER.map(([name, value]) => [name, name.endsWith("/ResponseType") ? "code id_token" : name.endsWith("/ResponseMode") ? "form_post" : value]), ...userinfo()], "USERINFO_ACCESS_TOKEN_MISSING", /hybrid response \(response type code id_token\) carries no access token/);
  // An online UserInfoEndpoint is the provider's: the local provider's endpoint answers for it.
  const online = await portal(t, [...CODE_PROVIDER, ...userinfo("https://idp.example.test/userinfo"), ["Authentication/OpenIdConnect/Code/LoginClaimsMapping", "mobilephone=userinfo.phone_number"]]);
  const reply = await online.finish(await online.startSignIn());
  await online.request(reply.headers.get("location"));
  assert.equal((await (await online.request("/__sim/api/state")).json()).data.contact[0].mobilephone, "+1 555 0100");
  assert.deepEqual((await online.status()).identityProvider.providers[0].userInfo, { enabled: true, endpoint: "https://idp.example.test/userinfo", localEndpoint: true });
});

test("Prompt, AcrValues and the ExternalLogin request's prompt, login_hint and allowed parameters reach the authorize request", async (t) => {
  const settings = [
    ...CODE_PROVIDER,
    ["Authentication/OpenIdConnect/Code/AcrValues", "mfa"],
    ["Authentication/OpenIdConnect/Code/AllowedDynamicAuthorizationParameters", "tenant_hint,client_id"],
  ];
  const site = await portal(t, settings);
  const authorize = await site.startSignIn("&prompt=select_account&login_hint=alex%40example.test&tenant_hint=contoso&campaign=x&client_id=intruder&redirect_uri=https%3A%2F%2Fevil.example%2F");
  const query = Object.fromEntries(authorize.searchParams);
  assert.deepEqual([query.prompt, query.login_hint, query.acr_values, query.tenant_hint, query.campaign, query.client_id, query.redirect_uri], ["select_account", "alex@example.test", "mfa", "contoso", undefined, "code-client", `${site.app.url}/`]);
  const { diagnostics } = await site.status();
  assert.equal(diagnostics.byCode.EXTERNAL_LOGIN_PARAMETER_IGNORED, 1);
  // An unsupported prompt is not sent.
  assert.equal((await site.startSignIn("&prompt=always")).searchParams.get("prompt"), null);
  // A Prompt setting that is not a supported value is reported and not sent.
  const invalid = await portal(t, [...settings, ["Authentication/OpenIdConnect/Code/Prompt", "always"]]);
  assert.equal((await invalid.startSignIn()).searchParams.get("prompt"), null);
  assert.equal((await invalid.status()).diagnostics.byCode.EXTERNAL_LOGIN_SETTING_INVALID, 1);
  // The Prompt site setting wins over the request's prompt.
  const fixed = await portal(t, [...settings, ["Authentication/OpenIdConnect/Code/Prompt", "login"]]);
  assert.equal((await fixed.startSignIn("&prompt=none")).searchParams.get("prompt"), "login");
  // prompt=none without a provider session: the provider's login_required reaches the sign-in page.
  const silent = await portal(t, [...CODE_PROVIDER, ["Authentication/OpenIdConnect/Code/Prompt", "none"]]);
  const authorizeSilent = await silent.startSignIn();
  const redirect = await fetch(authorizeSilent.href, { redirect: "manual" });
  const reply = await silent.request(redirect.headers.get("location"));
  assert.equal(reply.status, 400);
  assert.match(await reply.text(), /The identity provider returned login_required: prompt=none: no user is signed in/);
});

test("the built-in Microsoft Entra provider keeps the hybrid flow: no token request, no PKCE", async (t) => {
  const site = await portal(t, [
    ["Authentication/Registration/AzureADLoginEnabled", "true"],
    ["Authentication/Registration/LocalLoginEnabled", "false"],
    ["Authentication/OpenIdConnect/AzureAD/Authority", "https://login.windows.net/0f0f0f0f-1111-4222-8333-444444444444/"],
  ]);
  const authorize = await site.startSignIn("", "https://login.windows.net/0f0f0f0f-1111-4222-8333-444444444444/");
  assert.deepEqual([authorize.searchParams.get("response_type"), authorize.searchParams.get("response_mode"), authorize.searchParams.get("code_challenge")], ["code id_token", "form_post", null]);
  const reply = await site.finish(authorize);
  await site.request(reply.headers.get("location"));
  assert.equal(await site.signedIn(), "Alex Local");
  const provider = (await site.status()).identityProvider.providers[0];
  assert.deepEqual([provider.flow, provider.pkce, provider.tokenAuthMethod], ["hybrid", false, "client_secret_post"]);
});
