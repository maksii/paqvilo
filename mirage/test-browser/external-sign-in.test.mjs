import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { createSimulator } from "../server.mjs";

// The portal's own Sign in controls run the external sign-in through the runtime's local
// identity provider and back (docs/sim-administration.md, "External sign-in"). Shapes:
// Sample's header button that inserts a provider form posting a Microsoft authority, and
// Second's header link to the platform's sign-in page (capture: G/signin-chain/summary.json).

const TENANT = "https://login.windows.net/0f0f0f0f-1111-4222-8333-444444444444/";
const page = (id, name, partial, parent = "home") =>
  [`adx_webpageid: ${id}`, `adx_name: ${name}`, `adx_partialurl: ${partial}`, ...(parent ? [`adx_parentpageid: ${parent}`] : []), "adx_pagetemplateid: main"].join("\n");

// Sample shape: the button fetches the anti-forgery token and inserts the provider form.
const Sample_HEADER = [
  '<header id="site-header">{% if user %}<span id="who">{{ user.fullname }}</span> <a id="sign-out" href="{{ website.sign_out_url_substitution }}">Sign out</a>',
  '{% else %}<button id="nav-btn-signIn" type="button">Sign in</button> <a id="sign-in" href="{{ website.sign_in_url_substitution }}">Sign-in page</a>{% endif %}</header>',
  "<script>",
  "document.addEventListener('click', function (event) {",
  "  if (!event.target || event.target.id !== 'nav-btn-signIn') return;",
  "  fetch(window.location.origin + '/_layout/tokenhtml').then(function (response) { return response.text(); }).then(function (html) {",
  "    var token = new DOMParser().parseFromString(html, 'text/html').querySelector('input[name=\"__RequestVerificationToken\"]').value;",
  "    var form = document.createElement('form');",
  "    form.id = 'SignInModal'; form.method = 'post';",
  "    form.action = '/Account/Login/ExternalLogin?returnUrl=' + encodeURIComponent(window.location.pathname);",
  "    form.innerHTML = '<input name=\"__RequestVerificationToken\" type=\"hidden\"><button id=\"modal-signin-button\" name=\"provider\" type=\"submit\">Sign in with ExampleApp account</button>';",
  "    form.querySelector('input').value = token;",
  `    form.querySelector('button').value = '${TENANT}';`,
  "    document.querySelector('footer').appendChild(form);",
  "  });",
  "});",
  "</script>",
].join("\n");

function files(settings, header) {
  return {
    "website.yml": "adx_name: Sign-in Site\nadx_websiteid: site\nadx_headerwebtemplateid: header\nadx_footerwebtemplateid: footer\nadx_defaultlanguage: lang-en\nadx_website_language: 1033",
    "websitelanguage.yml": "- adx_websitelanguageid: lang-en\n  adx_name: English",
    "web-pages/home/Home.webpage.yml": page("home", "Home", "/", null),
    "web-pages/members/Members.webpage.yml": page("members", "Members", "members"),
    "page-templates/Main.pagetemplate.yml": "adx_pagetemplateid: main\nadx_webtemplateid: main",
    "web-templates/Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
    "web-templates/Main.webtemplate.source.html": '<h1 id="title">{{ page.title }}</h1><p id="user">{% if user %}{{ user.fullname }}{% else %}anonymous{% endif %}</p>',
    "web-templates/Header.webtemplate.yml": "adx_webtemplateid: header\nadx_name: Header",
    "web-templates/Header.webtemplate.source.html": header,
    "web-templates/Footer.webtemplate.yml": "adx_webtemplateid: footer\nadx_name: Footer",
    "web-templates/Footer.webtemplate.source.html": '<footer id="site-footer">Footer</footer>',
    "webrole.yml": "- adx_webroleid: member\n  adx_name: Member\n- adx_webroleid: signedin\n  adx_name: Authenticated Users\n  adx_authenticatedusersrole: true",
    "webpagerule.yml": "- adx_webpageaccesscontrolruleid: lock\n  adx_name: Members only\n  adx_webpageid: members\n  adx_right: 2\n  adx_scope: 1\n  adx_webpageaccesscontrolrule_webrole:\n  - member",
    "sitemarker.yml": "- adx_sitemarkerid: m-home\n  adx_name: Home\n  adx_pageid: home",
    "sitesetting.yml": settings.map(([name, value], index) => `- adx_sitesettingid: s${index}\n  adx_name: ${name}\n  adx_value: "${value}"`).join("\n"),
  };
}

const state = {
  version: 1,
  mappings: { contact: { entitySet: "contacts", idColumn: "contactid", nameColumn: "fullname" } },
  tables: {
    contact: [
      { contactid: "alex", fullname: "Alex Local", firstname: "Alex", lastname: "Local", emailaddress1: "alex@example.test", statecode: 0 },
      { contactid: "blair", fullname: "Blair Local", firstname: "Blair", lastname: "Local", statecode: 0 },
    ],
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

async function portal(t, settings, header) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-external-browser-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files(settings, header))) {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.writeFile(path.join(directory, name), body);
  }
  const app = await createSimulator({ sourceDir: directory, stateFile: path.join(directory, "state.json"), watch: false, initial: structuredClone(state) });
  t.after(() => app.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: "block" });
  const idp = app.identityProvider.origin;
  // Only the portal and its local identity provider are reachable.
  await context.route("**/*", (route) => {
    const url = route.request().url();
    return url.startsWith(app.url) || url.startsWith(idp) ? route.continue() : route.abort();
  });
  const tab = await context.newPage();
  const errors = [];
  tab.on("pageerror", (error) => errors.push(error.message));
  // Origins of every top-level navigation request, redirect hops included.
  const navigations = [];
  tab.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === tab.mainFrame()) navigations.push(new URL(request.url()).origin);
  });
  return { app, idp, tab, errors, navigations };
}

test("a portal's own Sign in button signs in through the local identity provider and its Sign out link signs out", { timeout: 90000 }, async (t) => {
  const settings = [
    ["Authentication/Registration/AzureADLoginEnabled", "true"],
    ["Authentication/Registration/ExternalLoginEnabled", "true"],
    ["Authentication/Registration/LocalLoginEnabled", "false"],
    ["Authentication/Registration/Enabled", "false"],
    ["Authentication/OpenIdConnect/AzureAD/Caption", "Sign In"],
  ];
  const { app, idp, tab, errors, navigations } = await portal(t, settings, Sample_HEADER);
  await tab.goto(app.url + "/");
  assert.equal(await tab.locator("#user").innerText(), "anonymous");
  // The authored control: the header button inserts the provider form; its button posts ExternalLogin.
  await tab.locator("#nav-btn-signIn").click();
  await tab.locator("#modal-signin-button").waitFor();
  await Promise.all([tab.waitForURL((url) => url.origin === idp), tab.locator("#modal-signin-button").click()]);
  assert.equal(await tab.title(), "Local identity provider (simulation)");
  assert.equal(new URL(tab.url()).pathname, "/azuread/oauth2/authorize");
  assert.equal(new URL(tab.url()).searchParams.get("redirect_uri"), app.url + "/");
  assert.equal(await tab.locator("li.paqvilo-mirage-idp-user").count(), 2);
  // Choosing a preset user posts the answer back to the site root, then ExternalLoginCallback returns home.
  await Promise.all([tab.waitForURL(app.url + "/"), tab.getByRole("button", { name: "Continue as Alex Local" }).click()]);
  assert.equal(await tab.locator("#who").innerText(), "Alex Local");
  assert.equal((await tab.goto(app.url + "/members/")).status(), 200);
  assert.equal(await tab.locator("#user").innerText(), "Alex Local");
  const session = await (await tab.request.get(app.url + "/_sim/api/session")).json();
  assert.deepEqual([session.contactId, session.provider?.id], ["alex", TENANT]);
  // Sign out (external logout is off): local sign-out; the protected page asks to sign in again.
  await Promise.all([tab.waitForURL((url) => url.pathname === "/signin" && url.searchParams.get("ReturnUrl") === "/members/"), tab.locator("#sign-out").click()]);
  // The platform's sign-in page lists the site's provider with its caption, and no local personas.
  const provider = tab.locator("form.paqvilo-mirage-provider button[name=provider]");
  assert.equal(await provider.innerText(), "Sign In");
  assert.equal(await provider.getAttribute("value"), TENANT);
  assert.equal(await tab.locator("li.paqvilo-mirage-persona").count(), 0);
  // A new user meets the site's registration settings (registration is off).
  await Promise.all([tab.waitForURL((url) => url.origin === idp), provider.click()]);
  await tab.getByLabel("Given name").fill("Nina");
  await tab.getByLabel("Family name").fill("New");
  await tab.getByLabel("Email").fill("nina@example.test");
  await Promise.all([tab.waitForURL((url) => url.origin === app.url && url.pathname === "/Account/Login/ExternalLoginCallback"), tab.getByRole("button", { name: "Continue as a new user" }).click()]);
  assert.equal(await tab.locator(".alert-danger").innerText(), "Registration is disabled for this site.");
  assert.ok(navigations.filter((origin) => origin === idp).length >= 2, "both sign-ins visited the identity provider");
  assert.deepEqual(errors, []);
});

test("the platform's sign-in page registers a new user through the provider, and Sign out runs the provider's end-session", { timeout: 90000 }, async (t) => {
  const settings = [
    ["Authentication/Registration/ExternalLoginEnabled", "true"],
    ["Authentication/Registration/LocalLoginEnabled", "false"],
    ["Authentication/OpenIdConnect/Local/Authority", "https://idp.example.test/local/"],
    ["Authentication/OpenIdConnect/Local/ClientId", "local-client"],
    ["Authentication/OpenIdConnect/Local/Caption", "Local IdP"],
    ["Authentication/OpenIdConnect/Local/ExternalLogoutEnabled", "true"],
  ];
  const header = '<header id="site-header">{% if user %}<span id="who">{{ user.fullname }}</span> <a id="sign-out" href="{{ website.sign_out_url_substitution }}">Sign out</a>{% else %}<a id="sign-in" href="{{ website.sign_in_url_substitution }}">Sign in</a>{% endif %}</header>';
  const { app, idp, tab, errors, navigations } = await portal(t, settings, header);
  await tab.goto(app.url + "/");
  // Second shape: the header link opens the platform's sign-in page with the provider form.
  await Promise.all([tab.waitForURL((url) => url.pathname === "/SignIn"), tab.locator("#sign-in").click()]);
  const provider = tab.locator("form.paqvilo-mirage-provider button[name=provider]");
  assert.equal(await provider.innerText(), "Local IdP");
  await Promise.all([tab.waitForURL((url) => url.origin === idp), provider.click()]);
  await tab.getByLabel("Given name").fill("Dana");
  await tab.getByLabel("Family name").fill("New");
  await tab.getByLabel("Email").fill("dana@example.test");
  await Promise.all([tab.waitForURL(app.url + "/"), tab.getByRole("button", { name: "Continue as a new user" }).click()]);
  assert.equal(await tab.locator("#who").innerText(), "Dana New");
  // Registration recorded the contact and its external identity.
  const { identities } = await (await tab.request.get(app.url + "/_sim/api/session/identities")).json();
  assert.deepEqual(identities.map((item) => [item.contactName, item.origin]), [["Dana New", "registration"]]);
  const personas = await (await tab.request.get(app.url + "/_sim/api/personas")).json();
  assert.ok(personas.personas.some((persona) => persona.name === "Dana New"));
  // Sign out: LogOff, the provider's end-session, back to the portal anonymous.
  const before = navigations.length;
  await Promise.all([tab.waitForURL(app.url + "/"), tab.locator("#sign-out").click()]);
  assert.ok(navigations.slice(before).includes(idp), "sign-out visited the identity provider's end-session");
  assert.equal(await tab.locator("#user").innerText(), "anonymous");
  // Switching accounts: sign in again as a preset user through the provider page.
  await Promise.all([tab.waitForURL((url) => url.pathname === "/SignIn"), tab.locator("#sign-in").click()]);
  await Promise.all([tab.waitForURL((url) => url.origin === idp), provider.click()]);
  await Promise.all([tab.waitForURL(app.url + "/"), tab.getByRole("button", { name: "Continue as Blair Local" }).click()]);
  assert.equal(await tab.locator("#who").innerText(), "Blair Local");
  assert.deepEqual(errors, []);
});

test("the authorization code flow runs end to end in the browser: the provider's redirect carries only the code, and UserInfo claims register the user", { timeout: 90000 }, async (t) => {
  const settings = [
    ["Authentication/Registration/ExternalLoginEnabled", "true"],
    ["Authentication/Registration/LocalLoginEnabled", "false"],
    ["Authentication/OpenIdConnect/Code/Authority", "https://idp.example.test/code/"],
    ["Authentication/OpenIdConnect/Code/ClientId", "code-client"],
    ["Authentication/OpenIdConnect/Code/ClientSecret", "s3cret"],
    ["Authentication/OpenIdConnect/Code/Caption", "Code IdP"],
    ["Authentication/OpenIdConnect/Code/ResponseType", "code"],
    ["Authentication/OpenIdConnect/Code/ResponseMode", "query"],
    ["Authentication/OpenIdConnect/Code/UseUserInfoEndpointforClaims", "true"],
    ["Authentication/OpenIdConnect/Code/RegistrationClaimsMapping", "firstname=given_name,lastname=family_name,emailaddress1=email,telephone1=userinfo.phone_number"],
  ];
  const header = '<header id="site-header">{% if user %}<span id="who">{{ user.fullname }}</span> <a id="sign-out" href="{{ website.sign_out_url_substitution }}">Sign out</a>{% else %}<a id="sign-in" href="{{ website.sign_in_url_substitution }}">Sign in</a>{% endif %}</header>';
  const { app, idp, tab, errors } = await portal(t, settings, header);
  const urls = [];
  tab.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === tab.mainFrame()) urls.push(new URL(request.url()));
  });
  await tab.goto(app.url + "/");
  await Promise.all([tab.waitForURL((url) => url.pathname === "/SignIn"), tab.locator("#sign-in").click()]);
  const provider = tab.locator("form.paqvilo-mirage-provider button[name=provider]");
  assert.equal(await provider.innerText(), "Code IdP");
  await Promise.all([tab.waitForURL((url) => url.origin === idp), provider.click()]);
  const authorize = new URL(tab.url());
  assert.deepEqual([authorize.searchParams.get("response_type"), authorize.searchParams.get("response_mode"), authorize.searchParams.get("code_challenge_method")], ["code", "query", "S256"]);
  await tab.getByLabel("Given name").fill("Nia");
  await tab.getByLabel("Family name").fill("New");
  await tab.getByLabel("Email").fill("nia@example.test");
  await tab.getByLabel(/Phone/).fill("+44 20 7946 0000");
  await Promise.all([tab.waitForURL(app.url + "/"), tab.getByRole("button", { name: "Continue as a new user" }).click()]);
  assert.equal(await tab.locator("#who").innerText(), "Nia New");
  // The browser saw the code at the reply URL; the tokens stayed between the portal and the provider.
  const replies = urls.filter((url) => url.origin === app.url && url.searchParams.has("code"));
  assert.equal(replies.length, 1);
  assert.deepEqual([...replies[0].searchParams.keys()], ["code", "state"]);
  assert.ok(!urls.some((url) => url.searchParams.has("id_token") || url.searchParams.has("access_token")), "no token in any browser URL");
  assert.ok(urls.some((url) => url.pathname === "/Account/Login/ExternalLoginCallback"));
  // Registration mapped the UserInfo phone number.
  const contacts = (await (await tab.request.get(app.url + "/__sim/api/state")).json()).data.contact;
  assert.equal(contacts.find((row) => row.emailaddress1 === "nia@example.test").telephone1, "+44 20 7946 0000");
  // A preset user signs in through the same flow.
  await Promise.all([tab.waitForURL((url) => url.pathname === "/"), tab.locator("#sign-out").click()]);
  await Promise.all([tab.waitForURL((url) => url.pathname === "/SignIn"), tab.locator("#sign-in").click()]);
  await Promise.all([tab.waitForURL((url) => url.origin === idp), provider.click()]);
  await Promise.all([tab.waitForURL(app.url + "/"), tab.getByRole("button", { name: "Continue as Alex Local" }).click()]);
  assert.equal(await tab.locator("#who").innerText(), "Alex Local");
  assert.deepEqual(errors, []);
});
