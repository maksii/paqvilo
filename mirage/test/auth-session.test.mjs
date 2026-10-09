import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSimulator } from "../server.mjs";
import {
  AUTH_COOKIE,
  authCookieName,
  authRoute,
  createAuthSessions,
  parseCookies,
  returnUrlParameter,
  safeReturnUrl,
  signInContent,
} from "../lib/auth-session.mjs";
import { signInHeaders } from "../testing/session.mjs";

const page = (id, name, partial, parent = "home") =>
  [
    `adx_webpageid: ${id}`,
    `adx_name: ${name}`,
    `adx_partialurl: ${partial}`,
    ...(parent ? [`adx_parentpageid: ${parent}`] : []),
    "adx_pagetemplateid: main",
  ].join("\n");

const portalFiles = {
  "website.yml": [
    "adx_name: Session Site",
    "adx_websiteid: site",
    "adx_headerwebtemplateid: header",
    "adx_footerwebtemplateid: footer",
    "adx_defaultlanguage: lang-en",
    "adx_website_language: 1033",
  ].join("\n"),
  "websitelanguage.yml": "- adx_websitelanguageid: lang-en\n  adx_name: English",
  "web-pages/home/Home.webpage.yml": page("home", "Home", "/", null),
  "web-pages/members/Members.webpage.yml": page("members", "Members", "members"),
  "web-pages/profile/Profile.webpage.yml": page("profile", "Profile", "profile"),
  "web-pages/not-found/Page-Not-Found.webpage.yml": page("notfound", "Page Not Found", "page-not-found"),
  "web-pages/denied/Access-Denied.webpage.yml": page("denied", "Access Denied", "access-denied"),
  "page-templates/Main.pagetemplate.yml": "adx_pagetemplateid: main\nadx_webtemplateid: main",
  "web-templates/Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
  "web-templates/Main.webtemplate.source.html":
    '<h1 id="title">{{ page.title }}</h1><p id="user">{% if user %}{{ user.fullname }}{% else %}anonymous{% endif %}</p>{% fetchxml items %}<fetch><entity name="sample_item"><attribute name="sample_name"/></entity></fetch>{% endfetchxml %}<p id="items">{{ items.results.entities.size }}</p>',
  "web-templates/Header.webtemplate.yml": "adx_webtemplateid: header\nadx_name: Header",
  "web-templates/Header.webtemplate.source.html":
    '<header id="site-header">{% if user %}<span id="who">{{ user.fullname }}</span> <a id="sign-out" href="{{ website.sign_out_url_substitution }}">Sign out</a>{% else %}<a id="sign-in" href="{{ website.sign_in_url_substitution }}">Sign in</a>{% endif %}</header>',
  "web-templates/Footer.webtemplate.yml": "adx_webtemplateid: footer\nadx_name: Footer",
  "web-templates/Footer.webtemplate.source.html": '<footer id="site-footer">Session footer</footer>',
  "webrole.yml": [
    "- adx_webroleid: member\n  adx_name: Member",
    "- adx_webroleid: signedin\n  adx_name: Authenticated Users\n  adx_authenticatedusersrole: true",
    "- adx_webroleid: visitors\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true",
  ].join("\n"),
  "webpagerule.yml":
    "- adx_webpageaccesscontrolruleid: lock\n  adx_name: Members only\n  adx_webpageid: members\n  adx_right: 2\n  adx_scope: 1\n  adx_webpageaccesscontrolrule_webrole:\n  - member",
  "sitemarker.yml": [
    "- adx_sitemarkerid: m-home\n  adx_name: Home\n  adx_pageid: home",
    "- adx_sitemarkerid: m-404\n  adx_name: Page Not Found\n  adx_pageid: notfound",
    "- adx_sitemarkerid: m-403\n  adx_name: Access Denied\n  adx_pageid: denied",
    "- adx_sitemarkerid: m-profile\n  adx_name: Profile\n  adx_pageid: profile",
  ].join("\n"),
  "sitesetting.yml": [
    "- adx_sitesettingid: s1\n  adx_name: Webapi/sample_item/enabled\n  adx_value: \"true\"",
    "- adx_sitesettingid: s2\n  adx_name: Webapi/sample_item/fields\n  adx_value: sample_name",
    "- adx_sitesettingid: s3\n  adx_name: Authentication/Registration/LocalLoginEnabled\n  adx_value: \"false\"",
    "- adx_sitesettingid: s4\n  adx_name: Authentication/OpenIdConnect/AzureAD/Caption\n  adx_value: Work account",
  ].join("\n"),
};

const ITEM = "11111111-1111-4111-8111-111111111111";
const NOTE = "22222222-2222-4222-8222-222222222222";
const initialState = (identity = { contactId: "alex", roleSource: "memberships", roles: [] }) => ({
  version: 1,
  mappings: {
    contact: { entitySet: "contacts", idColumn: "contactid", nameColumn: "fullname" },
    account: { entitySet: "accounts", idColumn: "accountid", nameColumn: "name" },
    sample_item: { entitySet: "sample_items", idColumn: "sample_itemid", nameColumn: "sample_name" },
    annotation: { entitySet: "annotations", idColumn: "annotationid" },
  },
  tables: {
    contact: [
      { contactid: "alex", fullname: "Alex Local", parentcustomerid: { id: "helios", logical_name: "account" }, statecode: 0 },
      { contactid: "blair", fullname: "Blair Local", parentcustomerid: { id: "boreal", logical_name: "account" }, statecode: 0 },
      { contactid: "carol", fullname: "Carol Inactive", statecode: 1 },
    ],
    account: [
      { accountid: "helios", name: "Helios" },
      { accountid: "boreal", name: "Boreal" },
    ],
    sample_item: [
      { sample_itemid: ITEM, sample_name: "First" },
      { sample_itemid: "33333333-3333-4333-8333-333333333333", sample_name: "Second" },
    ],
    annotation: [
      {
        annotationid: NOTE,
        subject: "Evidence",
        filename: "evidence.txt",
        mimetype: "text/plain",
        documentbody: Buffer.from("evidence").toString("base64"),
        objectid: { id: ITEM, logical_name: "sample_item" },
      },
    ],
  },
  permissions: [
    { id: "items", entity: "sample_item", roles: ["Member"], scope: "global", operations: ["read"] },
    { id: "notes", entity: "annotation", roles: ["Member"], scope: "global", operations: ["read"] },
  ],
  settings: { permissionMode: "enforce" },
  simulator: {
    mode: "local",
    pageMode: "local",
    permissionSource: "configured",
    identity,
    contactRoles: [{ contactId: "alex", roleId: "member" }],
    live: { allowWrites: false },
    endpoints: [],
  },
});

async function simulator(t, initial = initialState()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-auth-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(portalFiles)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, "state.json"), port: 0, watch: false, initial });
  t.after(() => app.close());
  const state = await (await fetch(app.url + "/__sim/api/state?summary=1")).json();
  // A browser sends Fetch Metadata (Sec-Fetch-Site) with every request.
  const browser = (target, { cookie, headers = {}, ...init } = {}) =>
    fetch(app.url + target, {
      redirect: "manual",
      ...init,
      headers: { "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}), ...headers },
    });
  const signIn = async (contactId, returnUrl = "/") => {
    const response = await browser("/SignIn", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ contactId, ReturnUrl: returnUrl }),
    });
    return { response, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? null };
  };
  return { app, csrf: state.csrf, browser, signIn };
}

const text = async (response) => response.text();
const field = (html, id) => new RegExp(`id="${id}">([^<]*)<`).exec(html)?.[1] ?? null;

test("session cookies are signed, scoped and reject tampering", () => {
  const sessions = createAuthSessions({ secret: Buffer.from("fixed secret for the test") });
  const cookie = sessions.cookie({ contactId: "alex" });
  assert.match(cookie, new RegExp(`^${AUTH_COOKIE}=[^;]+; Path=/; HttpOnly; SameSite=Lax$`));
  const header = cookie.split(";")[0];
  assert.deepEqual(sessions.read(header), { contactId: "alex" });
  assert.deepEqual(sessions.read(`other=1; ${header}`), { contactId: "alex" });
  assert.deepEqual(sessions.read(sessions.cookie({ contactId: null }).split(";")[0]), { contactId: null });
  assert.deepEqual(sessions.read(sessions.cookie({ contactId: "zed", roles: ["Member"] }).split(";")[0]), { contactId: "zed", roles: ["Member"] });
  const [name, value] = header.split("=");
  const tampered = `${name}=${Buffer.from(JSON.stringify({ c: "blair" })).toString("base64url")}.${value.split(".")[1]}`;
  assert.equal(sessions.read(tampered), null);
  assert.equal(createAuthSessions().read(header), null);
  assert.equal(sessions.read("paqvilo-mirage-auth=garbage"), null);
  assert.equal(sessions.read(""), null);
  assert.deepEqual(parseCookies("a=1; b = two=2;; c"), { a: "1", b: "two=2" });
  // Runtimes on other ports use their own cookie names in the same browser.
  assert.equal(authCookieName(8787), "paqvilo-mirage-auth-8787");
  assert.equal(authCookieName(null), AUTH_COOKIE);
  const sample = createAuthSessions({ name: () => authCookieName(8787) });
  const second = createAuthSessions({ name: authCookieName(8788) });
  const both = `${sample.cookie({ contactId: "alex" }).split(";")[0]}; ${second.cookie({ contactId: "blair" }).split(";")[0]}`;
  assert.equal(sample.name, "paqvilo-mirage-auth-8787");
  assert.deepEqual([sample.read(both), second.read(both)], [{ contactId: "alex" }, { contactId: "blair" }]);
});

test("return URLs must be same-origin relative paths", () => {
  for (const [value, expected] of [
    ["/members/?tab=1#top", "/members/?tab=1#top"],
    ["/", "/"],
    ["//evil.example/x", "/"],
    ["/%2F/evil.example", "/"],
    ["https://evil.example/", "/"],
    ["javascript:alert(1)", "/"],
    ["/\\evil.example", "/"],
    ["members/", "/"],
    ["", "/"],
    [null, "/"],
  ])
    assert.equal(safeReturnUrl(value), expected, String(value));
  assert.equal(returnUrlParameter(new URLSearchParams("RETURNURL=%2Fx%2F")), "/x/");
  assert.equal(returnUrlParameter(new URLSearchParams("other=1")), null);
});

test("sign-in and sign-out routes follow the platform paths", () => {
  for (const pathname of ["/SignIn", "/signin/", "/Account/Login", "/account/login/login", "/Account/Login/ExternalLogin", "/Account/Login/Register"])
    assert.deepEqual(authRoute(pathname, "GET"), { kind: "sign-in-page" }, pathname);
  assert.deepEqual(authRoute("/SignIn", "POST"), { kind: "sign-in-post" });
  assert.deepEqual(authRoute("/Account/Login/ExternalLogin", "POST"), { kind: "sign-in-page" });
  assert.deepEqual(authRoute("/Account/Login/LogOff", "GET"), { kind: "sign-out" });
  for (const pathname of ["/signin/extra", "/Account/Manage", "/members/"]) assert.equal(authRoute(pathname, "GET"), null, pathname);
});

test("the sign-in content lists personas, labels the simulation and escapes values", () => {
  const html = signInContent({
    personas: [
      { contactId: "b", name: "Blair <b>", roles: [], accountName: null },
      { contactId: "a", name: "Alex", roles: ["Member", "Reviewer"], accountName: "Helios & Co" },
    ],
    defaultContactId: "a",
    returnUrl: "/members/?x=\"1\"",
    anonymousUrl: "/",
    csrf: "token-1",
  });
  assert.match(html, /Local sign-in simulation/);
  assert.match(html, /This site configures no external identity provider/);
  assert.ok(html.indexOf("Alex") < html.indexOf("Blair"), "the default persona is listed first");
  assert.match(html, /<strong>Alex<\/strong> · Helios &amp; Co <span class="label label-info">default persona<\/span><br><small>Member, Reviewer<\/small>/);
  assert.match(html, /Blair &lt;b&gt;/);
  assert.match(html, /no web roles/);
  assert.match(html, /name="ReturnUrl" value="\/members\/\?x=&quot;1&quot;"><input name="__RequestVerificationToken" type="hidden" value="token-1">/);
  // Anonymous visitors see the page, so "Continue anonymously" is a plain link.
  assert.match(html, /<a class="paqvilo-mirage-continue-anonymously" href="\/">Continue anonymously<\/a>/);
  assert.doesNotMatch(html, /paqvilo-mirage-provider|password|microsoftonline|b2clogin/i);
  // External providers: the platform's provider form per provider (sandbox /SignIn shape).
  const external = signInContent({
    providers: [{ id: "https://login.windows.net/tenant/", name: "AzureAD", caption: "Sign in <ExampleApp>" }],
    showPersonas: false,
    csrf: "token-2",
    returnUrl: "/members/",
    invitationCode: "CODE&1",
    redeemInvitation: true,
  });
  assert.match(
    external,
    /<form action="\/Account\/Login\/ExternalLogin\?ReturnUrl=%2Fmembers%2F" method="post" class="paqvilo-mirage-provider"><input name="__RequestVerificationToken" type="hidden" value="token-2"><input name="InvitationCode" type="hidden" value="CODE&amp;1"><button name="provider" type="submit" class="btn btn-primary" value="https:\/\/login.windows.net\/tenant\/" title="Sign in &lt;ExampleApp&gt;">Sign in &lt;ExampleApp&gt;<\/button><\/form>/,
  );
  assert.match(external, /href="\/Account\/Login\/RedeemInvitation\?ReturnUrl=%2Fmembers%2F">Redeem invitation/);
  assert.doesNotMatch(external, /paqvilo-mirage-persona|Continue anonymously|Local sign-in simulation/);
  assert.match(signInContent({ showPersonas: false }), /No sign-in method is available/);
});

test("portal requests are anonymous without a session cookie, whoever the client is", async (t) => {
  const { app, browser, signIn } = await simulator(t);
  // The configured persona (Alex, a member) is not an implicit login for a browser.
  const anonymous = await browser("/members/?tab=1");
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get("location"), app.url + "/en-US/signin?ReturnUrl=%2Fmembers%2F%3Ftab%3D1");
  assert.match(await text(anonymous), /<title>Access Denied/);
  const home = await text(await browser("/"));
  assert.equal(field(home, "user"), "anonymous");
  assert.equal(field(home, "items"), "0");
  assert.match(home, /<a id="sign-in" href="\/SignIn\?returnUrl=%2F">Sign in<\/a>/);
  assert.equal((await browser("/_api/sample_items?$select=sample_name")).status, 403);
  assert.equal((await browser(`/_entity/annotation/${NOTE}`)).status, 404);
  // Without Fetch Metadata (scripts, tests) the visitor is anonymous as well ...
  assert.equal((await fetch(app.url + "/members/", { redirect: "manual" })).status, 302);
  assert.equal(field(await (await fetch(app.url + "/")).text(), "user"), "anonymous");
  // ... until the tool signs in explicitly (simulator.signIn, test/helpers/session.mjs).
  const script = await fetch(app.url + "/members/", { headers: signInHeaders(app, "alex") });
  assert.equal(script.status, 200);
  assert.equal(field(await script.text(), "user"), "Alex Local");
  // Signing in sets the session cookie and returns to the requested page.
  const { response, cookie } = await signIn("alex", "/members/?tab=1");
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/members/?tab=1");
  assert.match(response.headers.get("set-cookie"), new RegExp(`^${authCookieName(new URL(app.url).port)}=[^;]+; Path=/; HttpOnly; SameSite=Lax$`));
  const members = await text(await browser("/members/", { cookie }));
  assert.equal(field(members, "user"), "Alex Local");
  assert.equal(field(members, "who"), "Alex Local");
  assert.equal(field(members, "items"), "2");
  assert.match(members, /<a id="sign-out" href="\/Account\/Login\/LogOff\?returnUrl=%2Fmembers%2F">Sign out<\/a>/);
  const api = await browser("/_api/sample_items?$select=sample_name", { cookie });
  assert.equal(api.status, 200);
  assert.equal((await api.json()).value.length, 2);
  const note = await browser(`/_entity/annotation/${NOTE}`, { cookie });
  assert.equal(note.status, 200);
  assert.equal(await note.text(), "evidence");
  // The profile page requires a signed-in user.
  assert.equal((await browser("/profile/")).status, 302);
  assert.equal((await browser("/profile/", { cookie })).status, 200);
  // A signed-in persona without the page role sees Access Denied (403).
  const blair = await signIn("blair");
  const denied = await browser("/members/", { cookie: blair.cookie });
  assert.equal(denied.status, 403);
  assert.match(await text(denied), /<title>Access Denied/);
  // Tampered or foreign cookies are anonymous.
  assert.equal((await browser("/members/", { cookie: `${authCookieName(new URL(app.url).port)}=forged.value` })).status, 302);
});

test("the sign-in page renders in the site shell; sign-in validates personas and return URLs; sign-out ends the session", async (t) => {
  const { app, browser, signIn, csrf } = await simulator(t);
  // /{code}/signin answers with a second 302 (relative Location) to the code-less sign-in
  // path, as live Second and Third do (MultiLanguage/DisplayLanguageCodeInURL is not true).
  const hop = await browser("/en-US/signin?ReturnUrl=%2Fmembers%2F");
  assert.equal(hop.status, 302);
  assert.equal(hop.headers.get("location"), "/signin?ReturnUrl=%2Fmembers%2F");
  const page = await browser(hop.headers.get("location"));
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-sim-route"), "sign-in-page");
  const html = await text(page);
  assert.match(html, /<header id="site-header"><a id="sign-in"/);
  assert.match(html, /<footer id="site-footer">Session footer<\/footer>/);
  assert.match(html, /<title>Sign in/);
  assert.match(html, /Local sign-in simulation/);
  assert.match(html, /<strong>Alex Local<\/strong> · Helios <span class="label label-info">default persona<\/span><br><small>[^<]*Member/);
  assert.match(html, /<strong>Blair Local<\/strong> · Boreal<br>/);
  assert.doesNotMatch(html, /Carol Inactive/);
  assert.match(html, /name="ReturnUrl" value="\/members\/"/);
  // Members is not readable anonymously, so "Continue anonymously" goes home.
  assert.match(html, /href="\/">Continue anonymously/);
  // LocalLoginEnabled is false, but without an external provider the personas stay listed.
  assert.match(html, /This site configures no external identity provider/);
  assert.doesNotMatch(html, /paqvilo-mirage-provider/);
  // Submit exactly what the rendered form posts for Alex (URL-encoded, as a browser does).
  const action = /<form method="post" action="([^"]+)">/.exec(html)[1];
  const hidden = /name="ReturnUrl" value="([^"]*)"/.exec(html)[1];
  const button = /name="contactId" value="([^"]*)">Sign in<\/button><strong>Alex Local/.exec(html)[1];
  const submitted = await browser(action, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ReturnUrl: hidden, contactId: button }),
  });
  assert.equal(submitted.status, 302);
  assert.equal(submitted.headers.get("location"), "/members/");
  const submittedCookie = submitted.headers.get("set-cookie").split(";")[0];
  assert.equal(field(await text(await browser("/members/", { cookie: submittedCookie })), "user"), "Alex Local");
  // The LogOff GET the header link sends.
  const logOff = await browser("/Account/Login/LogOff?returnUrl=%2F", { cookie: submittedCookie });
  assert.equal(logOff.status, 302);
  assert.equal(logOff.headers.get("location"), "/");
  assert.equal(field(await text(await browser("/", { cookie: logOff.headers.get("set-cookie").split(";")[0] })), "user"), "anonymous");
  for (const target of ["/SignIn", "/signin", "/Account/Login", "/Account/Login/ExternalLogin", "/Account/Login/Register"]) {
    const response = await browser(target);
    assert.equal(response.status, 200, target);
    assert.match(await text(response), /Local sign-in simulation/, target);
  }
  // ExternalLogin POSTs need the anti-forgery token and a provider of the site.
  for (const [body, message] of [
    [{ provider: "https://login.example/" }, /The anti-forgery token is missing or invalid/],
    [{ provider: "https://login.example/", __RequestVerificationToken: csrf }, /The provider &quot;https:\/\/login.example\/&quot; is not an identity provider of this site\./],
  ]) {
    const response = await browser("/Account/Login/ExternalLogin?returnUrl=%2Fmembers%2F", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("x-sim-route"), "sign-in-page");
    assert.match(await text(response), message);
  }
  // Only same-origin relative return URLs are followed.
  for (const returnUrl of ["//evil.example/x", "https://evil.example/", "/\\evil.example"])
    assert.equal((await signIn("alex", returnUrl)).response.headers.get("location"), "/", returnUrl);
  // Unknown or inactive contacts are rejected with the sign-in page.
  for (const contactId of ["nobody", "carol", ""]) {
    const rejected = await signIn(contactId, "/members/");
    assert.equal(rejected.response.status, 400, contactId);
    assert.equal(rejected.cookie, null, contactId);
    assert.match(await text(rejected.response), /Choose an active local persona to sign in\./);
  }
  // The rendered page's form posts contactId and ReturnUrl (URL-encoded); JSON works too.
  const posted = await browser("/SignIn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contactId: "blair", ReturnUrl: "/members/" }),
  });
  assert.equal(posted.status, 302);
  assert.equal(posted.headers.get("location"), "/members/");
  assert.match(posted.headers.get("set-cookie"), /^paqvilo-mirage-auth-\d+=[^;]+; Path=\/; HttpOnly; SameSite=Lax$/);
  const { response: formPost, cookie } = await signIn("alex");
  assert.equal(formPost.status, 302);
  assert.equal(formPost.headers.get("location"), "/");
  // Already signed in: the sign-in page returns to ReturnUrl (or /).
  const again = await browser("/SignIn?ReturnUrl=%2Fmembers%2F", { cookie });
  assert.equal(again.status, 302);
  assert.equal(again.headers.get("location"), "/members/");
  // Sign-out ends the session and returns to the validated returnUrl.
  const out = await browser("/Account/Login/LogOff?returnUrl=%2Fmembers%2F", { cookie });
  assert.equal(out.status, 302);
  assert.equal(out.headers.get("location"), "/members/");
  const signedOut = out.headers.get("set-cookie").split(";")[0];
  assert.notEqual(signedOut, cookie);
  assert.equal((await browser("/members/", { cookie: signedOut })).status, 302);
  assert.equal(field(await text(await browser("/", { cookie: signedOut })), "user"), "anonymous");
  const { cookie: again2 } = await signIn("alex");
  assert.equal((await browser("/Account/Login/LogOff?returnUrl=https%3A%2F%2Fevil.example", { cookie: again2 })).headers.get("location"), "/");
  // sandbox: LogOff needs a signed-in user; anonymous requests go to the sign-in path with
  // the LogOff path (no query) as ReturnUrl (capture: G/signin-chain/summary.json).
  for (const cookieHeader of [undefined, signedOut]) {
    const anonymous = await browser("/Account/Login/LogOff?returnUrl=%2F", { cookie: cookieHeader });
    assert.equal(anonymous.status, 302);
    assert.equal(anonymous.headers.get("location"), "/signin?ReturnUrl=%2FAccount%2FLogin%2FLogOff");
    assert.equal(anonymous.headers.get("set-cookie"), null);
  }
  assert.ok(app.url);
});

test("the session API signs the calling browser in and out (CSRF-protected) with optional role overrides", async (t) => {
  const { app, csrf, browser, signIn } = await simulator(t);
  const api = (route, body, { cookie, token = csrf } = {}) =>
    fetch(app.url + "/_sim/api/session" + route, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...(token ? { "x-sim-csrf": token } : {}), ...(cookie ? { cookie } : {}), "sec-fetch-site": "same-origin" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const anonymous = await (await api("")).json();
  assert.equal(anonymous.signedIn, false);
  assert.equal(anonymous.defaultPersona.contactId, "alex");
  const { cookie } = await signIn("alex");
  const current = await (await api("?returnUrl=%2Fmembers%2F", null, { cookie })).json();
  assert.deepEqual(
    { signedIn: current.signedIn, contactId: current.contactId, name: current.name, accountId: current.accountId, member: current.roles.includes("Member"), returnUrl: current.returnUrl },
    { signedIn: true, contactId: "alex", name: "Alex Local", accountId: "helios", member: true, returnUrl: "/members/" },
  );
  assert.equal((await api("/sign-in", { contactId: "blair" }, { token: null })).status, 403);
  assert.equal((await api("/sign-in", { contactId: "nobody" })).status, 404);
  const blair = await api("/sign-in", { contactId: "blair", returnUrl: "//evil.example" });
  assert.equal(blair.status, 200);
  const blairBody = await blair.json();
  assert.equal(blairBody.contactId, "blair");
  assert.equal(blairBody.returnUrl, "/");
  assert.equal(blairBody.cookie.name, authCookieName(new URL(app.url).port));
  const blairCookie = blair.headers.get("set-cookie").split(";")[0];
  assert.equal(blairCookie, `${blairBody.cookie.name}=${blairBody.cookie.value}`);
  assert.equal(field(await text(await browser("/", { cookie: blairCookie })), "user"), "Blair Local");
  // A manual role override applies to this browser session only.
  const override = await api("/sign-in", { contactId: "blair", roles: ["Member"] });
  const overrideCookie = override.headers.get("set-cookie").split(";")[0];
  assert.equal((await override.json()).roleSource, "override");
  assert.equal((await browser("/members/", { cookie: overrideCookie })).status, 200);
  assert.equal((await browser("/members/", { cookie: blairCookie })).status, 403);
  const out = await api("/sign-out", {}, { cookie: overrideCookie });
  assert.equal((await out.json()).signedIn, false);
  assert.equal((await browser("/members/", { cookie: out.headers.get("set-cookie").split(";")[0] })).status, 302);
  // A membership session whose contact becomes inactive is anonymous.
  const snapshot = app.store.snapshot();
  snapshot.tables.contact.find((row) => row.contactid === "alex").statecode = 1;
  await app.store.replaceState(snapshot);
  assert.equal(field(await text(await browser("/", { cookie })), "user"), "anonymous");
});

test("simulator.identityScope configured (alias all-requests) gives cookie-less portal requests the configured identity", async (t) => {
  for (const scope of ["configured", "all-requests"]) {
    const initial = initialState();
    initial.simulator.identityScope = scope;
    const { app } = await simulator(t, initial);
    const members = await fetch(app.url + "/members/", { redirect: "manual" });
    assert.equal(members.status, 200, scope);
    assert.equal(field(await members.text(), "user"), "Alex Local", scope);
  }
});

test("simulator.signIn and the shared helper give tools a session; admin operations keep the configured persona", async (t) => {
  const { app } = await simulator(t);
  const signed = app.signIn("alex");
  assert.match(signed.cookieHeader, new RegExp(`^${authCookieName(new URL(app.url).port)}=[^;\\s]+$`));
  assert.deepEqual(
    { signedIn: signed.identity.signedIn, contactId: signed.identity.contactId, name: signed.identity.name, accountId: signed.identity.accountId, member: signed.identity.roles.includes("Member") },
    { signedIn: true, contactId: "alex", name: "Alex Local", accountId: "helios", member: true },
  );
  assert.equal(field(await (await fetch(app.url + "/members/", { headers: { cookie: signed.cookieHeader } })).text(), "user"), "Alex Local");
  assert.deepEqual(signInHeaders(app, "alex"), { cookie: app.signIn("alex").cookieHeader });
  assert.throws(() => app.signIn("nobody"), (error) => error.status === 404 && error.code === "PERSONA_CONTACT_UNAVAILABLE");
  assert.throws(() => app.signIn("carol"), (error) => error.status === 404);
  assert.throws(() => app.signIn(""), /contactId must be a local contact ID/);
  assert.throws(() => app.signIn("alex", { roles: "Member" }), /roles must be an array/);
  // A manual role override needs no contact record.
  const override = app.signIn("zed", { roles: ["Member"] });
  assert.equal(override.identity.roleSource, "override");
  assert.equal((await fetch(app.url + "/members/", { headers: { cookie: override.cookieHeader }, redirect: "manual" })).status, 200);
  // /_sim/api administration requests use the configured persona.
  const status = await (await fetch(app.url + "/__sim/api/status")).json();
  assert.equal(status.identity.contactId, "alex");
});
