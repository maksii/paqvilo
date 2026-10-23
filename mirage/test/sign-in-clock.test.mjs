import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSimulator } from "../server.mjs";
import { fixedClock } from "../lib/runtime-clock.mjs";
import { ownedFixture } from "../testing/owned-fixture.mjs";

// Helpers copied from external-sign-in.test.mjs (a test file cannot be imported without running its tests).
const AUTHORITY = "https://idp.example.test/local/";
const decode = (value) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const hiddenFields = (html) => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(([, name, value]) => [name, decode(value)]));
const formBody = (fields) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
const claimsOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));


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

async function simulator(t, settings = LOCAL_PROVIDER, state = initialState(), options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-external-"));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(portalFiles(settings))) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, "state.json"), port: 0, watch: false, initial: state, ...options });
  let closed = false;
  ownedFixture(t).add(() => (closed ? undefined : app.close()));
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

async function signInChain(t, clock, settings = LOCAL_PROVIDER, beforePostBack = () => {}) {
  const { app, idp } = await simulator(t, settings, initialState(), { clock });
  const browser = client(app);
  const challenge = await startSignIn(browser, { returnUrl: "/" });
  const answer = await choose(browser, challenge.headers.get("location"), { contactId: "alex" });
  beforePostBack();
  return { claims: claimsOf(hiddenFields(answer).id_token), response: await postBack(browser, answer, idp.origin) };
}

test("the local IdP code flow signs in under a fixed host clock far from wall time", async (t) => {
  for (const start of ["2026-01-01T00:00:00.000Z", "2027-06-01T00:00:00.000Z"]) {
    const clock = fixedClock(Date.parse(start));
    const { claims, response } = await signInChain(t, clock);
    assert.equal(claims.iat * 1000, Date.parse(start), "the identity provider issues on the host clock");
    assert.equal(response.status, 302, await response.clone().text());
    assert.match(response.headers.get("location"), /^\/Account\/Login\/ExternalLoginCallback/);
  }
});

test("advancing the fixed clock past the nonce lifetime rejects the callback", async (t) => {
  const clock = fixedClock(Date.parse("2026-01-01T00:00:00.000Z"));
  const settings = [...LOCAL_PROVIDER, ["Authentication/OpenIdConnect/Local/NonceLifetime", "00:05:00"]];
  const { response } = await signInChain(t, clock, settings, () => clock.advance(5 * 60 * 1000 + 1));
  assert.notEqual(response.status, 302);
  assert.match(await response.text(), /nonce has expired/);
});
