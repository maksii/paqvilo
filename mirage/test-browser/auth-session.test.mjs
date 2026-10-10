import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { createSimulator } from "../server.mjs";
import { signInContext } from "../testing/session.mjs";

const page = (id, name, partial, parent = "home") =>
  [`adx_webpageid: ${id}`, `adx_name: ${name}`, `adx_partialurl: ${partial}`, ...(parent ? [`adx_parentpageid: ${parent}`] : []), "adx_pagetemplateid: main"].join("\n");

const files = {
  "website.yml": "adx_name: Session Site\nadx_websiteid: site\nadx_headerwebtemplateid: header\nadx_footerwebtemplateid: footer\nadx_defaultlanguage: lang-en\nadx_website_language: 1033",
  "websitelanguage.yml": "- adx_websitelanguageid: lang-en\n  adx_name: English",
  "web-pages/home/Home.webpage.yml": page("home", "Home", "/", null),
  "web-pages/members/Members.webpage.yml": page("members", "Members", "members"),
  "web-pages/not-found/Page-Not-Found.webpage.yml": page("notfound", "Page Not Found", "page-not-found"),
  "web-pages/denied/Access-Denied.webpage.yml": page("denied", "Access Denied", "access-denied"),
  "page-templates/Main.pagetemplate.yml": "adx_pagetemplateid: main\nadx_webtemplateid: main",
  "web-templates/Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
  "web-templates/Main.webtemplate.source.html": '<h1 id="title">{{ page.title }}</h1><p id="user">{% if user %}{{ user.fullname }}{% else %}anonymous{% endif %}</p>',
  "web-templates/Header.webtemplate.yml": "adx_webtemplateid: header\nadx_name: Header",
  "web-templates/Header.webtemplate.source.html":
    '<header id="site-header">{% if user %}<span id="who">{{ user.fullname }}</span> <a id="sign-out" href="{{ website.sign_out_url_substitution }}">Sign out</a>{% else %}<a id="sign-in" href="{{ website.sign_in_url_substitution }}">Sign in</a>{% endif %}</header>',
  "web-templates/Footer.webtemplate.yml": "adx_webtemplateid: footer\nadx_name: Footer",
  "web-templates/Footer.webtemplate.source.html": '<footer id="site-footer">Session footer</footer>',
  "webrole.yml": "- adx_webroleid: member\n  adx_name: Member\n- adx_webroleid: signedin\n  adx_name: Authenticated Users\n  adx_authenticatedusersrole: true",
  "webpagerule.yml":
    "- adx_webpageaccesscontrolruleid: lock\n  adx_name: Members only\n  adx_webpageid: members\n  adx_right: 2\n  adx_scope: 1\n  adx_webpageaccesscontrolrule_webrole:\n  - member",
  "sitemarker.yml": [
    "- adx_sitemarkerid: m-home\n  adx_name: Home\n  adx_pageid: home",
    "- adx_sitemarkerid: m-404\n  adx_name: Page Not Found\n  adx_pageid: notfound",
    "- adx_sitemarkerid: m-403\n  adx_name: Access Denied\n  adx_pageid: denied",
  ].join("\n"),
};

test(
  "anonymous visitors sign in through the local sign-in page, sign out and switch personas",
  { timeout: 60000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-auth-browser-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    for (const [name, body] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
      await fs.writeFile(path.join(directory, name), body);
    }
    const app = await createSimulator({
      sourceDir: directory,
      stateFile: path.join(directory, "state.json"),
      watch: false,
      initial: {
        version: 1,
        mappings: {
          contact: { entitySet: "contacts", idColumn: "contactid", nameColumn: "fullname" },
          account: { entitySet: "accounts", idColumn: "accountid", nameColumn: "name" },
        },
        tables: {
          contact: [
            { contactid: "alex", fullname: "Alex Local", parentcustomerid: { id: "helios", logical_name: "account" } },
            { contactid: "blair", fullname: "Blair Local", parentcustomerid: { id: "boreal", logical_name: "account" } },
          ],
          account: [
            { accountid: "helios", name: "Helios" },
            { accountid: "boreal", name: "Boreal" },
          ],
        },
        settings: { permissionMode: "enforce" },
        simulator: {
          mode: "local",
          pageMode: "local",
          permissionSource: "configured",
          // The configured persona is only the default offered for sign-in.
          identity: { contactId: "alex", roleSource: "memberships", roles: [] },
          contactRoles: [{ contactId: "alex", roleId: "member" }],
          live: { allowWrites: false },
          endpoints: [],
        },
      },
    });
    t.after(() => app.close());
    const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
    t.after(() => browser.close());
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
    const portal = await context.newPage();
    const errors = [];
    portal.on("pageerror", (error) => errors.push(error.message));

    const hops = [];
    portal.on("response", (response) => {
      if (response.request().isNavigationRequest() && response.status() === 302) hops.push(new URL(response.url()).pathname);
    });
    await portal.goto(app.url + "/members/");
    assert.deepEqual(hops, ["/members/", "/en-US/signin"]);
    assert.equal(new URL(portal.url()).pathname, "/signin");
    assert.equal(new URL(portal.url()).searchParams.get("ReturnUrl"), "/members/");
    await portal.getByText("Local sign-in simulation", { exact: false }).waitFor();
    assert.equal(await portal.locator("#site-footer").innerText(), "Session footer");
    assert.equal(await portal.locator("li.paqvilo-mirage-persona").count(), 2);

    // Choose Alex: back on the protected page, signed in.
    await Promise.all([portal.waitForURL(app.url + "/members/"), portal.locator('li[data-contact-id="alex"] button').click()]);
    assert.equal(await portal.locator("#who").innerText(), "Alex Local");
    assert.equal(await portal.locator("#user").innerText(), "Alex Local");

    // The header sign-out link ends the session; the protected page asks to sign in again.
    await Promise.all([portal.waitForURL((url) => url.pathname === "/signin" && url.search === "?ReturnUrl=%2Fmembers%2F"), portal.locator("#sign-out").click()]);
    await Promise.all([portal.waitForURL(app.url + "/"), portal.getByRole("link", { name: "Continue anonymously" }).click()]);
    assert.equal(await portal.locator("#user").innerText(), "anonymous");

    // Switch to another persona from the header sign-in link.
    await Promise.all([portal.waitForURL(/\/SignIn\?returnUrl=%2F$/), portal.locator("#sign-in").click()]);
    await Promise.all([portal.waitForURL(app.url + "/"), portal.locator('li[data-contact-id="blair"] button').click()]);
    assert.equal(await portal.locator("#who").innerText(), "Blair Local");
    // Blair has no Member role: the protected page shows Access Denied.
    const denied = await portal.goto(app.url + "/members/");
    assert.equal(denied.status(), 403);
    // Tools sign a whole context in through the session API (test/helpers/session.mjs).
    const signed = await signInContext(context, app, "alex");
    assert.equal(signed.contactId, "alex");
    assert.equal((await portal.goto(app.url + "/members/")).status(), 200);
    assert.equal(await portal.locator("#who").innerText(), "Alex Local");
    const cookies = await context.cookies(app.url);
    const session = cookies.find((cookie) => cookie.name === `paqvilo-mirage-auth-${new URL(app.url).port}`);
    assert.equal(session?.httpOnly, true);
    assert.equal(session?.sameSite, "Lax");
    assert.deepEqual(errors, []);
  },
);
