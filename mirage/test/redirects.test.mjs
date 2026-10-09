import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSimulator } from "../server.mjs";
import { importPortal } from "../lib/importer.mjs";
import {
  resolveUnmatchedRoute,
  deniedPageRoute,
  escapeDataString,
  languageRoute,
  siteMarkerRoute,
  servicePages,
  loginPath,
  signInPath,
  applyObserved,
  requestTargetUrl,
} from "../lib/redirects.mjs";
import { siteHeaders, sitePolicy, webFileHeaders, webFileDisposition, notModified } from "../lib/response-headers.mjs";
import { signInHeaders } from "../testing/session.mjs";

const page = (id, name, partial, parent = "home") =>
  [
    `adx_webpageid: ${id}`,
    `adx_name: ${name}`,
    `adx_partialurl: ${partial}`,
    ...(parent ? [`adx_parentpageid: ${parent}`] : []),
    "adx_pagetemplateid: main",
  ].join("\n");

const files = {
  "website.yml": "adx_name: Routing\nadx_websiteid: site\nadx_defaultlanguage: lang-en\nadx_website_language: 1033",
  "websitelanguage.yml": "- adx_websitelanguageid: lang-en\n  adx_name: English\n  adx_portallanguageid: portal-en",
  "web-pages/home/Home.webpage.yml": page("home", "Home", "/", null),
  "web-pages/secure/Secure.webpage.yml": page("secure", "Secure", "secure"),
  "web-pages/not-found/Page-Not-Found.webpage.yml": page("notfound", "Page Not Found", "page-not-found"),
  "web-pages/denied/Access-Denied.webpage.yml": page("denied", "Access Denied", "access-denied"),
  "web-pages/renamed/New-Name.webpage.yml": page("renamed", "New Name", "new-name"),
  "web-pages/renamed-child/Child.webpage.yml": page("renamed-child", "Child", "child", "renamed"),
  "web-pages/kb/Knowledge.webpage.yml": page("kb", "Knowledge", "kb"),
  "web-pages/kb-article/Article.webpage.yml": page("kbarticle", "Article", "article", "kb"),
  "page-templates/Main.pagetemplate.yml":
    "adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false",
  "web-templates/Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
  "web-templates/Main.webtemplate.source.html":
    "<!doctype html><html><head><title>{{ page.title }}</title></head><body><h1>{{ page.title }}</h1><p>{{ request.path }}</p></body></html>",
  "webrole.yml": "- adx_webroleid: member\n  adx_name: Member\n- adx_webroleid: signedin\n  adx_name: Authenticated Users\n  adx_authenticatedusersrole: true",
  "webpagerule.yml":
    "- adx_webpageaccesscontrolruleid: lock\n  adx_name: Members only\n  adx_webpageid: secure\n  adx_right: 2\n  adx_scope: 1\n  adx_webpageaccesscontrolrule_webrole:\n  - member",
  "sitemarker.yml": [
    "- adx_sitemarkerid: m-home\n  adx_name: Home\n  adx_pageid: home",
    "- adx_sitemarkerid: m-404\n  adx_name: Page Not Found\n  adx_pageid: notfound",
    "- adx_sitemarkerid: m-403\n  adx_name: Access Denied\n  adx_pageid: denied",
    "- adx_sitemarkerid: m-secure\n  adx_name: Secure Area\n  adx_pageid: secure",
    "- adx_sitemarkerid: m-kb\n  adx_name: Knowledge Article\n  adx_pageid: kbarticle",
  ].join("\n"),
  "redirect.yml": [
    "- adx_redirectid: r-page\n  adx_name: Go\n  adx_inboundurl: go\n  adx_statuscode: 301\n  adx_webpageid: secure",
    "- adx_redirectid: r-url\n  adx_name: Promo\n  adx_inboundurl: /promo?x=1\n  adx_redirecturl: https://example.test/promo",
    "- adx_redirectid: r-marker\n  adx_name: Marker\n  adx_inboundurl: ~/area\n  adx_sitemarkerid: m-secure",
    "- adx_redirectid: r-kb\n  adx_name: Old article\n  adx_inboundurl: kb/article\n  adx_statuscode: 301\n  adx_webpageid: home",
    "- adx_redirectid: r-gone\n  adx_name: Gone\n  adx_inboundurl: gone\n  adx_statuscode: 301\n  adx_sitemarkerid: m-404",
  ].join("\n"),
  "urlhistory.yml": [
    "- adx_urlhistoryid: h1\n  adx_name: ~/old-name\n  adx_webpageid: renamed\n  adx_changeddate: 2024-01-01T00:00:00Z",
  ].join("\n"),
  "web-files/doc.txt.webfile.yml": "adx_webfileid: doc\nadx_name: doc.txt\nadx_partialurl: doc.txt\nadx_parentpageid: secure",
  "web-files/doc.txt": "protected document",
  "web-files/site.css.webfile.yml": "adx_webfileid: css\nadx_name: site.css\nadx_partialurl: site.css\nadx_parentpageid: home",
  "web-files/site.css": "body { color: teal; }",
  "web-files/logo.png.webfile.yml": "adx_webfileid: logo\nadx_name: logo.png\nadx_partialurl: logo.png\nadx_parentpageid: home",
  "web-files/logo.png": "PNG",
};

async function exportDir(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-routing-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries({ ...files, ...overrides })) {
    if (body === null) continue;
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  return dir;
}

async function simulator(t, overrides = {}) {
  const dir = await exportDir(t, overrides);
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, "state.json"), port: 0, watch: false });
  t.after(() => app.close());
  // Portal routes take their identity from the session cookie only (anonymous without it).
  let session = {};
  const get = (target, init = {}) => fetch(app.url + target, { redirect: "manual", ...init, headers: { ...session, ...(init.headers ?? {}) } });
  const signInAs = (contactId, roles) => {
    session = signInHeaders(app, contactId, { roles });
  };
  const signOut = () => {
    session = {};
  };
  const settings = (values) => {
    const snapshot = app.store.snapshot();
    return app.store.replaceState({ ...snapshot, settings: { ...snapshot.settings, ...values } });
  };
  return { app, dir, get, signInAs, signOut, settings };
}

test("unresolved paths follow redirects and the canonical slash before Page Not Found; URL history is opt-in", async (t) => {
  const portal = await importPortal(await exportDir(t));
  const route = (target, options = {}) => resolveUnmatchedRoute(portal, new URL(target, "http://local.invalid"), options);
  assert.deepEqual(
    (({ status, location, source }) => ({ status, location, source }))(route("/go")),
    { status: 301, location: "/secure/", source: "redirect" },
  );
  // Case-insensitive match of path and query; the default status is 302.
  assert.equal(route("/PROMO?x=1").location, "https://example.test/promo");
  assert.equal(route("/PROMO?x=1").status, 302);
  assert.equal(route("/promo?x=2").kind, "render");
  // A trailing slash on the requested path is ignored (sandbox: /x/ follows the redirect "x").
  assert.equal(route("/go/").location, "/secure/");
  assert.equal(route("/promo/?x=1").location, "https://example.test/promo");
  assert.equal(route("/area").location, "/secure/");
  // A redirect to the Page Not Found site marker answers with that page's URL.
  assert.equal(route("/gone/").location, "/page-not-found/");
  // Canonical trailing slash: 301 when readable, 302 to the slash form otherwise.
  assert.equal(route("/new-name?tab=2").location, "/new-name/?tab=2");
  assert.equal(route("/new-name?tab=2").status, 301);
  assert.equal(route("/secure", { readable: () => false }).status, 302);
  assert.equal(route("/secure", { readable: () => false }).location, "/secure/");
  // URL history is not applied by default (sandbox answers 404) ...
  assert.equal(route("/old-name").status, 404);
  // ... and follows adx_urlhistory, also with a trailing slash or a child segment, when enabled.
  for (const [target, location] of [["/old-name", "/new-name/"], ["/old-name/", "/new-name/"], ["/old-name/child/", "/new-name/child/"]]) {
    const history = route(target, { urlHistory: true });
    assert.equal(history.status, 301, target);
    assert.equal(history.location, location, target);
    assert.equal(history.source, "url-history", target);
  }
  const missing = route("/missing/");
  assert.equal(missing.kind, "render");
  assert.equal(missing.status, 404);
  assert.equal(missing.page.id, "notfound");
  // Sign-in routes answer before page routing (lib/auth-session.mjs); here /SignIn is no page.
  assert.equal(route("/SignIn?ReturnUrl=%2fsecure%2f").status, 404);
  delete portal.siteMarkers;
  assert.equal(route("/missing/").kind, "error");
  assert.equal(servicePages(portal).notFound, null);
});

test("denied pages redirect anonymous visitors to the absolute language sign-in URL with the Access Denied page", async (t) => {
  const portal = await importPortal(await exportDir(t));
  assert.equal(portal.language.code, "en-US");
  const url = new URL("http://local.invalid/MySecure/a b/?q='~'");
  const anonymous = deniedPageRoute(portal, url, { id: null }, { code: "PAGE_ACCESS_DENIED" }, { origin: "http://127.0.0.1:5000" });
  assert.equal(anonymous.status, 302);
  // Requested casing and query are kept; RFC 3986 escaping with upper-case hex.
  assert.equal(anonymous.location, "http://127.0.0.1:5000/en-US/signin?ReturnUrl=" + escapeDataString(url.pathname + url.search));
  assert.equal(escapeDataString("/a b/?x='~'(*)!"), "%2Fa%20b%2F%3Fx%3D%27~%27%28%2A%29%21");
  assert.equal(anonymous.page.id, "denied");
  // Without a known website language the sign-in path has no language segment.
  portal.language = null;
  portal.websiteLanguages = [];
  assert.equal(deniedPageRoute(portal, new URL("http://local.invalid/secure/"), {}, {}).location, "/signin?ReturnUrl=%2Fsecure%2F");
  const signedIn = deniedPageRoute(portal, url, { id: "person" }, { code: "PAGE_ACCESS_DENIED" });
  assert.equal(signedIn.status, 403);
  assert.equal(signedIn.page.id, "denied");
  assert.equal(deniedPageRoute(portal, url, { id: "person" }, { status: 404, code: "LANGUAGE_UNPUBLISHED" }).status, 404);
  portal.siteMarkers = portal.siteMarkers.filter((marker) => marker.name !== "Access Denied");
  assert.equal(deniedPageRoute(portal, url, { id: "person" }, {}).page.id, "notfound");
});

test("language prefixes and the Knowledge Article site-marker route resolve as on sandbox", async (t) => {
  const portal = await importPortal(await exportDir(t));
  const at = (target) => new URL(target, "http://local.invalid");
  // Website language codes are removed with a 302 (query kept); unknown codes are ordinary segments.
  assert.deepEqual(
    (({ kind, status, location }) => ({ kind, status, location }))(languageRoute(portal, at("/en-US/secure/?x=1"))),
    { kind: "redirect", status: 302, location: "/secure/?x=1" },
  );
  assert.equal(languageRoute(portal, at("/EN-us")).location, "/");
  assert.equal(languageRoute(portal, at("/fr-FR/secure/")), null);
  assert.equal(languageRoute(portal, at("/secure/")), null);
  // /{code}/signin follows the same rule: live Second and Third answer it with a second 302
  // (relative Location) to the sign-in path without the code, keeping the query.
  assert.deepEqual(
    (({ kind, status, location }) => ({ kind, status, location }))(languageRoute(portal, at("/en-US/signin?returnurl=%2Fsecure%2F"))),
    { kind: "redirect", status: 302, location: "/signin?returnurl=%2Fsecure%2F" },
  );
  // The sign-in path is Authentication/ApplicationCookie/LoginPath when exported (casing
  // kept), else /signin; values that are not a site-relative path are ignored.
  assert.equal(loginPath(portal), "/signin");
  for (const [value, expected] of [["/SignIn", "/SignIn"], [" /account/login ", "/account/login"], ["//evil.example/x", "/signin"], ["https://evil.example/", "/signin"], ["signin", "/signin"], ["/signin?x=1", "/signin"]]) {
    portal.settings["Authentication/ApplicationCookie/LoginPath"] = value;
    assert.equal(loginPath(portal), expected, value);
  }
  delete portal.settings["Authentication/ApplicationCookie/LoginPath"];
  // Other methods, and sites that display the code in URLs, continue without the code.
  assert.deepEqual(languageRoute(portal, at("/en-US/secure/"), "POST"), { kind: "rewrite", pathname: "/secure/", code: "en-US" });
  portal.settings["MultiLanguage/DisplayLanguageCodeInURL"] = "true";
  assert.equal(languageRoute(portal, at("/en-us/secure/")).kind, "rewrite");
  // Knowledge Article: path without "/", case-insensitive, with {number}/{lang}; no deeper paths.
  for (const target of ["/KB/ARTICLE", "/kb/article/KA-01001", "/kb/article/KA-01001/en-US/"])
    assert.equal(siteMarkerRoute(portal, at(target))?.page.id, "kbarticle", target);
  assert.equal(siteMarkerRoute(portal, at("/kb/article/a/b/c/")), null);
  assert.equal(siteMarkerRoute(portal, at("/kb/")), null);
});

test("parentless web files are served at their partial URL and never shadow the page at a path ending with /", async (t) => {
  const { get } = await simulator(t, {
    // Example: a parentless web file whose partial URL starts with "//" (not an authority).
    "web-files/config.json.webfile.yml": "adx_webfileid: rte\nadx_name: config.json\nadx_partialurl: //RTE/config.json",
    "web-files/config.json": '{"rte":true}',
    // A parentless web file at "/" yields to the home page there.
    "web-files/root.txt.webfile.yml": "adx_webfileid: rootfile\nadx_name: root.txt\nadx_partialurl: /",
    "web-files/root.txt": "root file",
    // Two pages claim /twin/: the first in export order is served.
    "web-pages/twin/Twin.webpage.yml": "- adx_webpageid: twina\n  adx_name: Twin A\n  adx_partialurl: twin\n  adx_parentpageid: home\n  adx_pagetemplateid: main\n- adx_webpageid: twinb\n  adx_name: Twin B\n  adx_partialurl: twin\n  adx_parentpageid: home\n  adx_pagetemplateid: main",
  });
  const home = await get("/");
  assert.equal(home.status, 200);
  assert.ok((await home.text()).includes("<title>Home</title>"));
  for (const target of ["/RTE/config.json", "/rte/config.json", "//RTE/config.json"]) {
    const file = await get(target);
    assert.equal(file.status, 200, target);
    assert.equal(await file.text(), '{"rte":true}', target);
  }
  // A request target starting with "//" is a path, never a host.
  const parsed = requestTargetUrl("//RTE/config.json?x=1", "http://127.0.0.1:1");
  assert.deepEqual([parsed.host, parsed.pathname, parsed.search], ["127.0.0.1:1", "//RTE/config.json", "?x=1"]);
  assert.equal(requestTargetUrl("/a/b", "http://127.0.0.1:1").href, "http://127.0.0.1:1/a/b");
  const twin = await get("/twin/");
  assert.equal(twin.status, 200);
  assert.ok((await twin.text()).includes("<title>Twin A</title>"));
});

test("a configured LoginPath is the sign-in path: its casing in both hops, its page and its POST", async (t) => {
  const { app, get } = await simulator(t, {
    "sitesetting.yml": "- adx_sitesettingid: login\n  adx_name: Authentication/ApplicationCookie/LoginPath\n  adx_value: /Account/SignIn",
  });
  const first = await get("/secure/");
  assert.equal(first.status, 302);
  assert.equal(first.headers.get("location"), app.url + "/en-US/Account/SignIn?ReturnUrl=%2Fsecure%2F");
  const second = await get("/en-US/Account/SignIn?ReturnUrl=%2Fsecure%2F");
  assert.equal(second.status, 302);
  assert.equal(second.headers.get("location"), "/Account/SignIn?ReturnUrl=%2Fsecure%2F");
  const page = await get("/account/signin/?ReturnUrl=%2Fsecure%2F");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-sim-route"), "sign-in-page");
  assert.ok((await page.text()).includes('name="ReturnUrl" value="/secure/"'));
  // The default /signin route keeps working beside the configured path.
  assert.equal((await get("/signin?ReturnUrl=%2Fsecure%2F")).status, 200);
  const posted = await get("/Account/SignIn", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "ReturnUrl=%2F&contactId=nobody" });
  // A POST to the configured path is a sign-in submission (an unknown persona re-renders it).
  assert.equal(posted.status, 400);
  assert.ok((await posted.text()).includes("Choose an active local persona to sign in."));
});

test("an observed sign-in path applies when the export sets no LoginPath; an exported LoginPath wins", async (t) => {
  // Third and Example sandbox answer /SignIn without the setting while Sample sandbox answers /signin:
  // the casing is a per-site observation with its evidence, never a name-based rule.
  const observed = { loginPath: "/SignIn", evidence: "docs/runtime-evidence.md" };
  const dir = await exportDir(t);
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, "state.json"), port: 0, watch: false, observed });
  t.after(() => app.close());
  const get = (target) => fetch(app.url + target, { redirect: "manual" });
  const first = await get("/secure/");
  assert.equal(first.status, 302);
  assert.equal(first.headers.get("location"), app.url + "/en-US/SignIn?ReturnUrl=%2Fsecure%2F");
  const second = await get("/en-US/SignIn?ReturnUrl=%2Fsecure%2F");
  assert.equal(second.status, 302);
  assert.equal(second.headers.get("location"), "/SignIn?ReturnUrl=%2Fsecure%2F");
  assert.equal((await get("/SignIn?ReturnUrl=%2Fsecure%2F")).status, 200);
  const { status } = await (await get("/__sim/api/state?summary=1")).json();
  assert.deepEqual(status.bootstrap.signInPath, { path: "/SignIn", source: "observed", evidence: observed.evidence });
  assert.deepEqual(status.bootstrap.observed, observed);
  // The export's own setting wins over an observation and the difference is reported.
  const portal = applyObserved(await importPortal(await exportDir(t, {
    "sitesetting.yml": "- adx_sitesettingid: login\n  adx_name: Authentication/ApplicationCookie/LoginPath\n  adx_value: /signin",
  })), observed);
  assert.deepEqual(signInPath(portal), { path: "/signin", source: "site-setting" });
  assert.deepEqual(portal.diagnostics.filter((d) => d.code.startsWith("LOGIN_PATH_")).map((d) => [d.code, d.configured, d.loginPath]), [["LOGIN_PATH_OBSERVED_IGNORED", "/signin", "/SignIn"]]);
  const unset = applyObserved(await importPortal(await exportDir(t)), observed);
  assert.deepEqual(unset.diagnostics.filter((d) => d.code.startsWith("LOGIN_PATH_")).map((d) => d.code), ["LOGIN_PATH_OBSERVED"]);
  assert.deepEqual(signInPath(await importPortal(await exportDir(t))), { path: "/signin", source: "default" });
  // Other observations attach to the portal without sign-in diagnostics.
  const webApi = applyObserved(await importPortal(await exportDir(t)), { webApiInnerError: "all-errors", evidence: "third-sandbox/report.json" });
  assert.deepEqual(webApi.observed, { webApiInnerError: "all-errors", evidence: "third-sandbox/report.json" });
  assert.equal(webApi.diagnostics.some((d) => d.code.startsWith("LOGIN_PATH_")), false);
  assert.deepEqual(signInPath(webApi), { path: "/signin", source: "default" });
  assert.equal(applyObserved(await importPortal(await exportDir(t)), { evidence: "nothing observed" }).observed, undefined);
  // The option is validated like the project and catalogue settings.
  await assert.rejects(createSimulator({ sourceDir: dir, stateFile: path.join(dir, "other-state.json"), port: 0, watch: false, observed: { loginPath: "/SignIn" } }), /observed\.evidence/);
});

test("the runtime renders Page Not Found (404), Access Denied (403), sign-in redirects and routing redirects", async (t) => {
  const { app, get, signInAs, signOut, settings } = await simulator(t);
  const missing = await get("/no-such-route/");
  assert.equal(missing.status, 404);
  const missingBody = await missing.text();
  assert.match(missingBody, /<title>Page Not Found<\/title>/);
  assert.match(missingBody, /<p>\/no-such-route\/<\/p>/);
  assert.doesNotMatch(missingBody, /Portal rendering needs attention/);
  const diagnostics = await (await get("/__sim/api/diagnostics")).json();
  assert.ok(diagnostics.diagnostics.some((d) => d.code === "PAGE_NOT_FOUND" && d.path === "/no-such-route/" && /No exported page or asset maps to \/no-such-route\/.*HTTP 404/.test(d.message)));
  // Anonymous: 302 to the absolute /en-US/signin URL with the Access Denied page as body.
  const anonymous = await get("/Secure/?tab=1");
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get("location"), app.url + "/en-US/signin?ReturnUrl=%2FSecure%2F%3Ftab%3D1");
  assert.match(anonymous.headers.get("content-type"), /^text\/html/);
  assert.match(await anonymous.text(), /<title>Access Denied<\/title>/);
  assert.equal((await get("/secure/doc.txt")).headers.get("location"), app.url + "/en-US/signin?ReturnUrl=%2Fsecure%2Fdoc.txt");
  // /en-US/signin: a second 302 with a relative Location to the code-less sign-in path,
  // as live Second and Third answer (MultiLanguage/DisplayLanguageCodeInURL is not true).
  const languageSignIn = await get("/en-US/signin?ReturnUrl=%2Fsecure%2F");
  assert.equal(languageSignIn.status, 302);
  assert.equal(languageSignIn.headers.get("location"), "/signin?ReturnUrl=%2Fsecure%2F");
  assert.equal(languageSignIn.headers.get("x-sim-route"), "language");
  for (const target of ["/signin?ReturnUrl=%2Fsecure%2F", "/SignIn?ReturnUrl=%2fsecure%2f"]) {
    const signIn = await get(target);
    assert.equal(signIn.status, 200, target);
    assert.match(await signIn.text(), /name="ReturnUrl" value="\/secure\/"/, target);
  }
  // A protected page without its slash: 302 to the slash form (sign-in follows there).
  assert.equal((await get("/secure")).status, 302);
  assert.equal((await get("/secure")).headers.get("location"), "/secure/");
  // Signed in without the page role: the Access Denied page with 403.
  signInAs("person", []);
  const denied = await get("/secure/");
  assert.equal(denied.status, 403);
  assert.match(await denied.text(), /<title>Access Denied<\/title>/);
  assert.equal((await get("/secure/doc.txt")).status, 403);
  // With the role the page renders; the canonical slash redirect is permanent.
  signInAs("person", ["Member"]);
  assert.equal((await get("/secure/")).status, 200);
  assert.equal(await (await get("/secure/doc.txt")).text(), "protected document");
  const canonical = await get("/secure?x=1");
  assert.equal(canonical.status, 301);
  assert.equal(canonical.headers.get("location"), "/secure/?x=1");
  assert.equal((await get("/go/")).headers.get("location"), "/secure/");
  // URL history only with settings.urlHistoryRedirects.
  assert.equal((await get("/old-name/child/")).status, 404);
  await settings({ urlHistoryRedirects: true });
  const history = await get("/old-name/child/");
  assert.equal(history.status, 301);
  assert.equal(history.headers.get("location"), "/new-name/child/");
  assert.equal(history.headers.get("x-sim-route"), "url-history");
  // Service pages remain readable to everyone; the Access Denied page answers 200.
  signOut();
  const accessDenied = await get("/access-denied/");
  assert.equal(accessDenied.status, 200);
  assert.match(await accessDenied.text(), /<title>Access Denied<\/title>/);
});

test("language prefixes, the Knowledge Article route and repeated slashes resolve before redirects", async (t) => {
  const { get } = await simulator(t);
  const prefixed = await get("/en-US/new-name/?tab=1");
  assert.equal(prefixed.status, 302);
  assert.equal(prefixed.headers.get("location"), "/new-name/?tab=1");
  assert.equal((await get("/fr-FR/new-name/")).status, 404);
  // ?lang= has no effect.
  assert.equal((await get("/new-name/?lang=fr-FR")).status, 200);
  // The Knowledge Article page answers its path without "/" although a redirect "kb/article" exists.
  const article = await get("/KB/ARTICLE");
  assert.equal(article.status, 200);
  const articleBody = await article.text();
  assert.match(articleBody, /<title>Article<\/title>/);
  assert.match(articleBody, /<p>\/KB\/ARTICLE<\/p>/);
  assert.equal((await get("/kb/article/KA-01001/")).status, 200);
  assert.equal((await get("/kb/article/")).status, 200);
  // Repeated slashes collapse before resolution (ExampleApp's "../" + "/page" links).
  const child = await get("/new-name//child/");
  assert.equal(child.status, 200);
  assert.match(await child.text(), /<p>\/new-name\/child\/<\/p>/);
  const collapsed = await get("/new-name//child?id=7");
  assert.equal(collapsed.status, 301);
  assert.equal(collapsed.headers.get("location"), "/new-name/child/?id=7");
});

test("portal responses carry only HTTP/* site-setting headers; web files use the record disposition and platform caching", async (t) => {
  const css = "body { color: teal; }";
  const { dir, get, signInAs, settings } = await simulator(t, {
    "sitesetting.yml": [
      "- adx_sitesettingid: s1\n  adx_name: HTTP/X-Frame-Options\n  adx_value: DENY",
      "- adx_sitesettingid: s2\n  adx_name: HTTP/Content-Security-Policy\n  adx_value: \"default-src 'self'; object-src 'none'; connect-src 'self' https://*.powerappsportals.com\"",
      "- adx_sitesettingid: s3\n  adx_name: HTTP/Content-Security-Policy/Enabled\n  adx_value: \"true\"",
      // Second: Referrer-Policy from its site setting; CORS settings are not echoed on loopback.
      "- adx_sitesettingid: s4\n  adx_name: HTTP/Referrer-Policy\n  adx_value: strict-origin-when-cross-origin",
      "- adx_sitesettingid: s5\n  adx_name: HTTP/Access-Control-Allow-Origin\n  adx_value: \"*\"",
      "- adx_sitesettingid: s6\n  adx_name: HTTP/SameSite/Default\n  adx_value: lax",
    ].join("\n"),
    "web-files/logo.png.webfile.yml": "adx_webfileid: logo\nadx_name: Logo\nadx_partialurl: logo.png\nadx_parentpageid: home\nadx_contentdisposition: 756150001\nfilename: logo.png",
  });
  const home = await get("/");
  assert.equal(home.status, 200);
  assert.equal(home.headers.get("cache-control"), "no-cache, no-store, must-revalidate");
  assert.equal(home.headers.get("x-frame-options"), "DENY");
  assert.equal(home.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  // One parseable policy: the site's own.
  assert.equal(home.headers.get("content-security-policy"), "default-src 'self'; object-src 'none'; connect-src 'self' https://*.powerappsportals.com");
  for (const absent of ["x-content-type-options", "access-control-allow-origin", "samesite"]) assert.equal(home.headers.get(absent), null, absent);
  // Web files: charset on every type, the record's disposition (none = inline), the
  // attachment file name, unquoted base64 SHA-256 ETag, Last-Modified and 304.
  const file = await get("/site.css");
  assert.equal(file.status, 200);
  assert.equal(await file.text(), css);
  assert.match(file.headers.get("content-type"), /^text\/css; ?charset=utf-8$/);
  assert.equal(file.headers.get("content-disposition"), "inline;filename*=UTF-8''site.css");
  const etag = createHash("sha256").update(css).digest("base64");
  assert.equal(file.headers.get("etag"), etag);
  const stat = await fs.stat(path.join(dir, "web-files", "site.css"));
  assert.equal(file.headers.get("last-modified"), new Date(Math.floor(stat.mtimeMs / 1000) * 1000).toUTCString());
  // The platform's caching by default: public for anonymous visitors, private when signed in.
  assert.equal(file.headers.get("cache-control"), "public, max-age=3600");
  assert.ok(file.headers.get("expires"));
  assert.equal(file.headers.get("x-frame-options"), "DENY");
  assert.equal(file.headers.get("x-content-type-options"), null);
  const cached = await get("/site.css", { headers: { "if-none-match": etag } });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "");
  assert.equal((await get("/site.css", { headers: { "if-none-match": '"other"' } })).status, 200);
  const logo = await get("/logo.png");
  assert.equal(logo.headers.get("content-type"), "image/png; charset=utf-8");
  assert.equal(logo.headers.get("content-disposition"), "attachment;filename*=UTF-8''logo.png");
  // no-cache is the explicit opt-in for a dev loop without timestamped links.
  await settings({ webFileCaching: "revalidate" });
  assert.equal((await get("/site.css")).headers.get("cache-control"), "no-cache");
  await settings({ webFileCaching: undefined });
  signInAs("person", []);
  assert.equal((await get("/site.css")).headers.get("cache-control"), "private, max-age=3600");
  // The Mirage's own responses keep nosniff.
  assert.equal((await get("/__sim/api/state?summary=1")).headers.get("x-content-type-options"), "nosniff");
  // Loopback confinement is an explicit opt-in: a separate policy beside the site's.
  const state = await (await get("/__sim/api/state?summary=1")).json();
  assert.equal(state.config.confinePortalPages, false);
  assert.deepEqual(state.status.confinement, { portalPages: false, policy: null });
  const patch = (body) => get("/__sim/api/config", { method: "PATCH", headers: { "content-type": "application/json", "x-sim-csrf": state.csrf }, body: JSON.stringify(body) });
  assert.equal((await patch({ confinePortalPages: "yes" })).status, 400);
  assert.equal((await patch({ confinePortalPages: true })).status, 200);
  const policies = (await get("/")).headers.get("content-security-policy");
  assert.ok(policies.startsWith("default-src 'self'; object-src 'none'; connect-src 'self' https://*.powerappsportals.com, default-src 'self' data: blob:;"), policies);
  const after = await (await get("/__sim/api/state?summary=1")).json();
  assert.equal(after.config.confinePortalPages, true);
  assert.equal(after.status.confinement.portalPages, true);
  assert.ok(after.status.confinement.policy.includes("connect-src 'self'"));
});

test("web files are served inline or as attachments from their Content-Disposition choice, in standard and enhanced exports", async (t) => {
  // adx_contentdisposition (enhanced content: contentdisposition): 756150000 inline (the form
  // default), 756150001 attachment, no value inline (Learn, Web File table reference).
  const standard = await simulator(t, {
    "web-files/numeric-inline.css.webfile.yml": "adx_webfileid: wf-inline\nadx_name: Numeric inline\nadx_partialurl: numeric-inline.css\nadx_parentpageid: home\nadx_contentdisposition: 756150000\nfilename: numeric-inline.css",
    "web-files/numeric-inline.css": "a{}",
    "web-files/download.pdf.webfile.yml": "adx_webfileid: wf-attachment\nadx_name: Download\nadx_partialurl: download.pdf\nadx_parentpageid: home\nadx_contentdisposition: 756150001\nfilename: download.pdf",
    "web-files/download.pdf": "%PDF-1.4",
    "web-files/quoted.txt.webfile.yml": "adx_webfileid: wf-quoted\nadx_name: Quoted\nadx_partialurl: quoted.txt\nadx_parentpageid: home\nadx_contentdisposition: \"756150001\"\nfilename: quoted.txt",
    "web-files/quoted.txt": "text",
    // A stylesheet web file named without an extension, with a .css attachment.
    "web-files/Style.webfile.yml": "adx_webfileid: wf-style\nadx_name: Style\nadx_partialurl: Style.css\nadx_parentpageid: home\nadx_contentdisposition: 756150000\nfilename: Style.css",
    "web-files/Style": "b{}",
  });
  const disposition = async (get, target) => {
    const response = await get(target);
    assert.equal(response.status, 200, target);
    return response.headers.get("content-disposition");
  };
  assert.equal(await disposition(standard.get, "/numeric-inline.css"), "inline;filename*=UTF-8''numeric-inline.css");
  assert.equal(await disposition(standard.get, "/download.pdf"), "attachment;filename*=UTF-8''download.pdf");
  assert.equal(await disposition(standard.get, "/quoted.txt"), "attachment;filename*=UTF-8''quoted.txt");
  assert.equal(await disposition(standard.get, "/Style.css"), "inline;filename*=UTF-8''Style.css");
  // The fixture's site.css has no value: inline.
  assert.equal(await disposition(standard.get, "/site.css"), "inline;filename*=UTF-8''site.css");

  const xmlText = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const component = (id, type, name, content, extra = "") =>
    `<powerpagecomponent powerpagecomponentid="${id}"><content>${xmlText(JSON.stringify(content))}</content>${extra}<name>${name}</name><powerpagecomponenttype>${type}</powerpagecomponenttype><statecode>0</statecode></powerpagecomponent>`;
  const HOME = "aaaaaaaa-0000-4000-8000-000000000001";
  const webFile = (id, name, content) => ({
    [`powerpagecomponents/${id}/powerpagecomponent.xml`]: component(id, 3, name, { parentpageid: HOME, partialurl: name, ...content }, `<filecontent mimetype="text/plain">${name}</filecontent>`),
    [`powerpagecomponents/${id}/filecontent/${name}`]: name,
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-enhanced-disposition-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    [`powerpagecomponents/${HOME}/powerpagecomponent.xml`]: component(HOME, 2, "Home", { partialurl: "/" }),
    ...webFile("bbbbbbbb-0000-4000-8000-000000000001", "theme.css", { contentdisposition: 756150000 }),
    // Example exports robots.txt with 756150001.
    ...webFile("bbbbbbbb-0000-4000-8000-000000000002", "robots.txt", { contentdisposition: 756150001 }),
    ...webFile("bbbbbbbb-0000-4000-8000-000000000003", "plain.js", {}),
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const enhanced = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, "state.json"), port: 0, watch: false });
  t.after(() => enhanced.close());
  const get = (target) => fetch(enhanced.url + target, { redirect: "manual" });
  assert.equal(await disposition(get, "/theme.css"), "inline;filename*=UTF-8''theme.css");
  assert.equal(await disposition(get, "/robots.txt"), "attachment;filename*=UTF-8''robots.txt");
  assert.equal(await disposition(get, "/plain.js"), "inline;filename*=UTF-8''plain.js");
});

test("headers follow the response kind: pages, web files and the token fragment, with observed headers per kind", async (t) => {
  // Sample sandbox sends nosniff on pages and web files and Access-Control-Allow-Origin on web
  // files without exporting either setting; the site records them as observed headers.
  const observed = {
    headers: {
      page: { "X-Content-Type-Options": "nosniff" },
      webFile: { "x-content-type-options": "nosniff", "access-control-allow-origin": "https://app.powerbi.com" },
    },
    evidence: "docs/runtime-evidence.md",
  };
  const dir = await exportDir(t, {
    "sitesetting.yml": "- adx_sitesettingid: csp\n  adx_name: HTTP/Content-Security-Policy\n  adx_value: \"default-src 'self'\"",
  });
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, "state.json"), port: 0, watch: false, observed });
  t.after(() => app.close());
  const get = (target) => fetch(app.url + target, { redirect: "manual" });
  const pick = (response, names) => Object.fromEntries(names.map((name) => [name, response.headers.get(name)]));
  const names = ["cache-control", "x-frame-options", "content-security-policy", "x-content-type-options", "access-control-allow-origin"];
  assert.deepEqual(pick(await get("/"), names), {
    "cache-control": "no-cache, no-store, must-revalidate",
    "x-frame-options": "SAMEORIGIN",
    "content-security-policy": "default-src 'self'",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": null,
  });
  const file = pick(await get("/site.css"), names);
  assert.deepEqual([file["x-content-type-options"], file["access-control-allow-origin"], file["x-frame-options"]], ["nosniff", "https://app.powerbi.com", "SAMEORIGIN"]);
  // /_layout/tokenhtml carries the page headers: site CSP, X-Frame-Options and the observed
  // page headers (G/wave3 headers-tokenhtml-anon lists content-security-policy and
  // x-content-type-options among the live header names).
  assert.deepEqual(pick(await get("/_layout/tokenhtml"), names), {
    "cache-control": "no-cache, no-store, must-revalidate",
    "x-frame-options": "SAMEORIGIN",
    "content-security-policy": "default-src 'self'",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": null,
  });
  // An exported setting wins over the observation; the observation never adds a header to
  // the other kind of response.
  const portal = (settings, kindHeaders) => ({ settings, observed: { headers: kindHeaders } });
  assert.equal(siteHeaders(portal({ "HTTP/X-Content-Type-Options": "nosniff-site" }, { page: { "x-content-type-options": "nosniff" } }), { kind: "page" })["x-content-type-options"], "nosniff-site");
  assert.equal(siteHeaders(portal({}, { webFile: { "x-content-type-options": "nosniff" } }), { kind: "page" })["x-content-type-options"], undefined);
  assert.equal(siteHeaders(portal({}, { page: { "x-content-type-options": "nosniff" } }))["x-content-type-options"], undefined);
});

test("site header settings: one header per HTTP/* setting, nonce policies and conditional requests", () => {
  const portal = (settings) => ({ settings });
  assert.deepEqual(siteHeaders(portal({})), { "x-frame-options": "SAMEORIGIN" });
  assert.deepEqual(siteHeaders(portal({}), { confinement: "connect-src 'self'" }), { "x-frame-options": "SAMEORIGIN", "content-security-policy": "connect-src 'self'" });
  assert.deepEqual(
    siteHeaders(portal({
      "HTTP/X-Content-Type-Options": "nosniff",
      "HTTP/Referrer-Policy": " strict-origin-when-cross-origin ",
      "http/permissions-policy": "camera=()",
      "HTTP/Permissions-Policy": "geolocation=()",
      "HTTP/Access-Control-Allow-Credentials": "true",
      "HTTP/Strict-Transport-Security": "max-age=1",
      "HTTP/SameSite/Default": "lax",
      "HTTP/X-Broken": "a\r\nInjected: 1",
      "HTTP/X-Empty": " ",
    })),
    { "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "permissions-policy": "camera=()", "x-frame-options": "SAMEORIGIN" },
  );
  assert.equal(sitePolicy(portal({ "HTTP/Content-Security-Policy": "script-src 'self' 'nonce'" })).reason, "nonce");
  assert.equal(sitePolicy(portal({ "http/content-security-policy": "default-src 'self'", "HTTP/Content-Security-Policy/Enabled": "false" })).reason, "disabled");
  assert.equal(sitePolicy(portal({ "HTTP/Content-Security-Policy": "default-src 'self'", "HTTP/Content-Security-Policy/InjectHeader": "false" })).reason, "not-injected");
  assert.deepEqual(siteHeaders(portal({ "HTTP/Content-Security-Policy": "default-src 'self'" }), { confinement: "connect-src 'self'" })["content-security-policy"], ["default-src 'self'", "connect-src 'self'"]);
  const headers = webFileHeaders({ body: "x", contentType: "text/plain; charset=utf-8", fileName: "a b'(1).txt", modified: new Date("2026-01-02T03:04:05.678Z") });
  assert.equal(headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(headers["content-disposition"], "inline;filename*=UTF-8''a%20b%27%281%29.txt");
  assert.equal(headers["cache-control"], "public, max-age=3600");
  assert.equal(headers["last-modified"], "Fri, 02 Jan 2026 03:04:05 GMT");
  assert.equal(webFileHeaders({ body: "x", fileName: "a.pdf", disposition: "attachment", signedIn: true })["cache-control"], "private, max-age=3600");
  assert.equal(webFileHeaders({ body: "x", fileName: "a.pdf", caching: "revalidate" })["cache-control"], "no-cache");
  assert.equal(webFileHeaders({ body: "x", fileName: "a.pdf", caching: "revalidate" }).expires, undefined);
  // adx_contentdisposition: 756150001 attachment; 756150000 or no value inline (Learn, Web File).
  assert.deepEqual(
    [webFileDisposition({ adx_contentdisposition: 756150001 }), webFileDisposition({ adx_contentdisposition: "756150000" }), webFileDisposition({ adx_contentdisposition: 756150000 }), webFileDisposition({}), webFileDisposition({ contentdisposition: 756150001 }), webFileDisposition({ contentdisposition: 756150000 }), webFileDisposition({ mspp_contentdisposition: 756150001 })],
    ["attachment", "inline", "inline", "inline", "attachment", "inline", "attachment"],
  );
  assert.equal(notModified({ "if-none-match": `"${headers.etag}"` }, headers), true);
  assert.equal(notModified({ "if-none-match": "x", "if-modified-since": "Sat, 03 Jan 2026 00:00:00 GMT" }, headers), false);
  assert.equal(notModified({ "if-modified-since": "Sat, 03 Jan 2026 00:00:00 GMT" }, headers), true);
  assert.equal(notModified({}, headers), false);
});

test("enhanced-model redirect components (type 30) import and route like adx_redirect records", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-enhanced-redirects-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const xmlText = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const component = (id, type, name, content, statecode = 0) => [
    `powerpagecomponents/${id}/powerpagecomponent.xml`,
    `<powerpagecomponent powerpagecomponentid="${id}"><content>${xmlText(JSON.stringify(content))}</content><name>${name}</name><powerpagecomponenttype>${type}</powerpagecomponenttype><statecode>${statecode}</statecode><statuscode>${statecode ? 2 : 1}</statuscode></powerpagecomponent>`,
  ];
  const HOME = "11111111-1111-4111-8111-111111111111";
  const TARGET = "22222222-2222-4222-8222-222222222222";
  const GONE = "33333333-3333-4333-8333-333333333333";
  const files = Object.fromEntries([
    component(HOME, 2, "Home", { partialurl: "/" }),
    component(TARGET, 2, "Target", { partialurl: "target", parentpageid: HOME }),
    component(GONE, 2, "Page Not Found", { partialurl: "page-not-found", parentpageid: HOME }),
    component("44444444-4444-4444-8444-444444444444", 13, "Page Not Found", { pageid: GONE }),
    component("55555555-5555-4555-8555-555555555555", 30, "Old target", { inboundurl: "old-target", statuscode: 301, webpageid: TARGET }),
    component("66666666-6666-4666-8666-666666666666", 30, "Promotion", { inboundurl: "/promo?x=1", redirecturl: "https://example.test/promo" }),
    component("77777777-7777-4777-8777-777777777777", 30, "Retired", { inboundurl: "~/retired", statuscode: 301, sitemarkerid: "44444444-4444-4444-8444-444444444444" }),
    component("88888888-8888-4888-8888-888888888888", 30, "Inactive", { inboundurl: "inactive", redirecturl: "/target/" }, 1),
  ]);
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const portal = await importPortal(dir);
  assert.equal(portal.format, "enhanced");
  assert.equal(portal.records.filter((record) => record.kind.startsWith("component:")).length, 0);
  assert.deepEqual(
    portal.redirects.map(({ name, inboundUrl, statusCode, redirectUrl, webPageId, siteMarkerId, active }) => ({ name, inboundUrl, statusCode, redirectUrl, webPageId, siteMarkerId, active })),
    [
      { name: "Old target", inboundUrl: "old-target", statusCode: 301, redirectUrl: null, webPageId: TARGET, siteMarkerId: null, active: true },
      { name: "Promotion", inboundUrl: "/promo?x=1", statusCode: null, redirectUrl: "https://example.test/promo", webPageId: null, siteMarkerId: null, active: true },
      { name: "Retired", inboundUrl: "~/retired", statusCode: 301, redirectUrl: null, webPageId: null, siteMarkerId: "44444444-4444-4444-8444-444444444444", active: true },
      { name: "Inactive", inboundUrl: "inactive", statusCode: null, redirectUrl: "/target/", webPageId: null, siteMarkerId: null, active: false },
    ].sort((a, b) => portal.redirects.findIndex((r) => r.name === a.name) - portal.redirects.findIndex((r) => r.name === b.name)),
  );
  const route = (target) => resolveUnmatchedRoute(portal, new URL(target, "http://local.invalid"));
  assert.deepEqual([route("/old-target").status, route("/old-target/").location], [301, "/target/"]);
  assert.deepEqual([route("/PROMO?x=1").status, route("/PROMO?x=1").location], [302, "https://example.test/promo"]);
  assert.equal(route("/retired").location, "/page-not-found/");
  // As with the legacy provider, the redirect query has no statecode filter; the match is flagged.
  assert.equal(route("/inactive").inactive, true);
});

test("without a Page Not Found site marker unknown routes keep the explicit 404 diagnostic", async (t) => {
  const { get } = await simulator(t, { "sitemarker.yml": "- adx_sitemarkerid: m-home\n  adx_name: Home\n  adx_pageid: home" });
  const response = await get("/no-such-route/");
  assert.equal(response.status, 404);
  assert.match(await response.text(), /No exported page or asset maps to \/no-such-route\//);
});
