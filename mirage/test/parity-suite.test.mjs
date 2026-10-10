// Parity-suite regressions: synthetic loopback fixtures only; no portal or browser is contacted.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import {
  assertReadOnlyPath,
  checkPersonaAccess,
  classifyDelta,
  classifyLiteral,
  classifyLocation,
  compareHeaders,
  compareJson,
  compareNetwork,
  compareTextLines,
  compareTrees,
  cookieShapes,
  createHttpDriver,
  createRedactor,
  etagShape,
  extractProbe,
  formatMask,
  isAllowedRequest,
  normalizeText,
  prepareTree,
  projectHeaders,
  projectJson,
  redactTree,
  redactUrl,
  requestDecision,
  runParitySuite,
  scenarioPath,
  segmentRoles,
  summaryMarkdown,
  treeText,
  validatePlan,
  withFetchXmlPage,
  compareBytes,
  letterCase,
  tagShape,
  __testing,
} from "../parity-suite.mjs";

const GUID_A = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const GUID_B = "c6d9e2d4-1c73-e811-a844-000d3a2a3148";
const element = (tag, attributes = {}, children = [], extra = {}) => ({ g: tag, a: attributes, v: 1, ...(children.length ? { c: children } : {}), ...extra });
const text = (value) => ({ t: value });

test("normalisers generalise identifiers, dates, tokens and origins", () => {
  const value = `Open ${GUID_A} on 2026-10-07T21:30:00Z (07/10/2026 21:30) by ana.local@example.test ref 1234567 at https://reference.example token ${"A".repeat(48)}`;
  assert.equal(
    normalizeText(value, { origins: ["https://reference.example"] }),
    "Open {guid} on {datetime} ({date} {time}) by {email} ref {n} at @portal token {token}",
  );
  assert.equal(normalizeText("  Owned\n   products  "), "Owned products");
  assert.equal(normalizeText("12 October 2025"), "{date}");
});

test("URL redaction keeps names and shapes but never query values", () => {
  assert.equal(redactUrl(`https://reference.example/requests/itemselection-ro/?id=${GUID_A}&orderId=1`, { origins: ["https://reference.example"] }), "/requests/itemselection-ro/?id=…&orderId=…");
  assert.equal(redactUrl(`/_api/contacts(${GUID_A})`), "/_api/contacts({guid})");
  assert.equal(redactUrl("https://login.microsoftonline.com/tenant/oauth2/authorize?state=secret&nonce=n"), "https://login.microsoftonline.com/tenant/oauth2/authorize?nonce=…&state=…");
  assert.equal(redactUrl("javascript:alert(1)"), "javascript:");
  assert.equal(redactUrl(`/fetchchangerequest-async/?count=10&page=2&status=${GUID_A}&top=x1`, { keepPaging: true }), "/fetchchangerequest-async/?count=10&page=2&status=…&top=…");
  assert.deepEqual(projectJson(JSON.stringify({ morerecords: true, changeRequests: [{ a: 1 }, { a: 2 }] })).arrays, { changeRequests: 2 });
  assert.equal(redactUrl("#tab-1"), "#tab-1");
});

test("live text is revealed only when source-derived, local-equal or trivially short", () => {
  const corpus = { has: (value) => value === "Owned products" };
  const redactor = createRedactor({ corpus, key: Buffer.alloc(32, 1) });
  redactor.rememberLocal("Alex Local");
  assert.equal(redactor.reveal("Owned products"), "Owned products");
  assert.equal(redactor.reveal("Alex Local"), "Alex Local");
  assert.equal(redactor.reveal("Yes"), "Yes");
  const hidden = redactor.reveal("Maria Example (real user)");
  assert.equal(hidden.redacted, true);
  assert.equal(hidden.length, "Maria Example (real user)".length);
  assert.equal(redactor.reveal("Maria Example (real user)").digest, hidden.digest);
  assert.notEqual(createRedactor({ key: Buffer.alloc(32, 2) }).reveal("Maria Example (real user)").digest, hidden.digest);
  assert.ok(!JSON.stringify(hidden).includes("Maria"));
});

test("read-only guards reject writes, deny-listed routes and unsafe plans", () => {
  assert.doesNotThrow(() => assertReadOnlyPath("/workspace/"));
  for (const bad of ["https://evil.example/", "//evil.example/", "/orders/submit/", "/Account/Login/LogOff", "/signout", "/clearcache/?id=1", "/_services/entity-grid-data.json/1", "/%2e%2e/x", "/__sim/api/state"])
    assert.throws(() => assertReadOnlyPath(bad), undefined, bad);
  const base = { version: 1, scenarios: [{ id: "a", kind: "page-dom", path: "/" }] };
  assert.doesNotThrow(() => validatePlan(base));
  assert.throws(() => validatePlan({ ...base, scenarios: [{ id: "a", kind: "api-json", path: "/_api/x", method: "POST" }] }), /GET/);
  assert.throws(() => validatePlan({ ...base, scenarios: [{ id: "a", kind: "page-dom", path: "/x/?id={id}" }] }), /without discovery/);
  assert.throws(() => validatePlan({ ...base, scenarios: [{ id: "a", kind: "api-json", path: "/_api/x", prefer: "return=representation" }] }), /Prefer/);
  assert.throws(() => validatePlan({ ...base, scenarios: [base.scenarios[0], base.scenarios[0]] }), /Duplicate/);
  assert.throws(() => validatePlan({ ...base, allowPost: [{ method: "POST", pathPrefix: "/filteritemselection/", reason: "documented read-only Liquid FetchXML page" }] }), /only GET and HEAD/);
  assert.doesNotThrow(() => validatePlan({ ...base, allowPost: [] }));
  assert.throws(() => validatePlan({ ...base, fulfil: [{ method: "GET", pathPattern: "^/x", status: 204, reason: "documented reason" }] }), /fulfilment/);
  assert.throws(() => validatePlan({ ...base, classifications: [{ class: "runtime-gap", note: "x" }] }), /owner/);
  assert.throws(() => validatePlan({ ...base, scenarios: [{ id: "a", kind: "page-dom", path: "/", discover: { from: "page", path: "/x/" } }] }), /selector/);
});

test("request decisions continue reads, fulfil explicit writes locally and block everything else", () => {
  const origins = ["https://reference.example"];
  const fulfil = [{ method: "PATCH", pathPattern: "^/_api/contacts\\(", status: 204, reason: "documented local answer" }];
  const allowList = [{ method: "POST", pathPrefix: "/_services/entity-grid-data.json/", reason: "read-only grid data request" }];
  assert.deepEqual(requestDecision("GET", "https://reference.example/x", { origins }), { action: "continue" });
  assert.equal(requestDecision("PATCH", `https://reference.example/_api/contacts(${GUID_A})`, { fulfil, origins }).action, "fulfil");
  assert.equal(requestDecision("PATCH", `https://other.example/_api/contacts(${GUID_A})`, { fulfil, origins }).action, "block");
  assert.equal(requestDecision("DELETE", `https://reference.example/_api/contacts(${GUID_A})`, { fulfil, origins }).action, "block");
  // An allow-list passed by a caller is ignored: only GET and HEAD reach the reference.
  assert.equal(requestDecision("POST", "https://reference.example/_services/entity-grid-data.json/1", { allowList, origins }).action, "block");
  assert.equal(requestDecision("POST", "https://reference.example/_api/sample_applications", { allowList, origins }).action, "block");
  assert.equal(isAllowedRequest("POST", "https://reference.example/_services/entity-grid-data.json/1", { allowList, origins }).allowed, false);
  assert.equal(requestDecision("POST", "https://dc.services.visualstudio.com/v2/track", { allowList, fulfil, origins }).action, "block");
});

test("semantic trees collapse data rows, redact control values and report structural deltas", () => {
  // A platform asset from the CDN and its local copy compare equal; bundle content hashes are ignored.
  assert.equal(prepareTree(element("img", { src: "https://content.powerapps.com/resource/powerappsportal/img/web.png" })).attrs.src, prepareTree(element("img", { src: "/resource/powerappsportal/img/web.png" })).attrs.src);
  assert.equal(prepareTree(element("script", { src: "https://content.powerapps.com/resource/powerappsportal/dist/app.bundle-79acd4df74.js" })).attrs.src, "/resource/powerappsportal/dist/app.bundle-{hash}.js");
  const row = (name) => element("tr", { class: "row" }, [element("td", {}, [text(name)]), element("td", {}, [element("a", { href: `/medicinalproduct-RO/?id=${GUID_A}`, title: "View" }, [text("View")])])]);
  const live = element("main", { id: "content", class: "sample b" }, [
    element("h1", {}, [text("Owned products")]),
    element("input", { type: "hidden", id: "userroles", value: "Review ManagerAuthenticated Users" }, [], { p: { value: "secret", checked: false, disabled: false } }),
    element("input", { type: "hidden", name: "__RequestVerificationToken", value: "token-value" }),
    element("table", {}, [element("tbody", {}, Array.from({ length: 25 }, (_, index) => row(`Live product ${index}`)))]),
    element("div", { class: "live-only" }, [text("Only live")]),
  ]);
  const local = element("main", { id: "content", class: "b sample extra" }, [
    element("h1", {}, [text("My products")]),
    element("input", { type: "hidden", id: "userroles", value: "Authenticated Users" }, [], { p: { value: "other", checked: false, disabled: false } }),
    element("input", { type: "hidden", name: "__RequestVerificationToken", value: "different" }),
    element("table", {}, [element("tbody", {}, Array.from({ length: 3 }, (_, index) => row(`Local product ${index}`)))]),
    element("span", { class: "local-only" }),
  ]);
  const a = prepareTree(live);
  const b = prepareTree(local);
  assert.equal(a.kids[1].attrs.value, "{value}");
  assert.equal(a.kids[2].attrs.value, "{redacted}");
  const tbody = a.kids[3].kids[0];
  assert.equal(tbody.kids.length, 1, "identical row structures collapse to one template");
  assert.equal(tbody.kids[0].repeat, 25);
  const { deltas } = compareTrees(a, b);
  const kinds = deltas.map((delta) => delta.kind).sort();
  assert.deepEqual(kinds, ["class", "extra", "missing", "repeat-count", "text", "text"].sort());
  assert.ok(deltas.some((delta) => delta.kind === "class" && delta.extra.includes("extra")));
  assert.ok(deltas.some((delta) => delta.kind === "repeat-count" && delta.live === 25 && delta.local === 3));
  assert.ok(!JSON.stringify(deltas).includes("secret") && !JSON.stringify(deltas).includes("token-value"));
  const dataRegion = prepareTree(element("div", { class: "user" }, [text("Real Person")], { d: 1 }));
  assert.equal(prepareTree({ t: "Real Person", d: 1 }).text, "{data}");
  assert.equal(dataRegion.data, true);
  const redactor = createRedactor({ key: Buffer.alloc(32, 3) });
  const saved = JSON.stringify(redactTree(a, redactor, "live"));
  assert.ok(!saved.includes("Live product") && !saved.includes("secret") && !saved.includes("token-value"));
  assert.deepEqual(treeText(prepareTree(element("p", {}, [text("A"), element("span", {}, [text("B")], { v: 0 })]))).map((line) => line.text), ["A"]);
  assert.deepEqual(compareTextLines([{ text: "A" }, { text: "B" }], [{ text: "A" }, { text: "C" }]).deltas.map((delta) => delta.kind), ["text-missing", "text-extra"]);
});

test("Web API projections compare shape, annotations, paging and reference values only on request", () => {
  const liveBody = JSON.stringify({ "@odata.context": "https://reference.example/_api/$metadata#x", "@odata.nextLink": "https://reference.example/_api/x?$skiptoken=%3Ccookie%20page%3D%222%22%3E", value: [{ id: GUID_A, name: "Ref", _list_value: GUID_B, "_list_value@OData.Community.Display.V1.FormattedValue": "Country", statecode: 0 }] });
  const localBody = JSON.stringify({ value: [{ id: GUID_A, name: "Ref", _list_value: GUID_B, statecode: "0" }] });
  const live = projectJson(liveBody, { referenceData: true });
  const local = projectJson(localBody, { referenceData: true });
  assert.equal(live.fields.id[0], "guid");
  assert.equal(live.nextLink, "/_api/x?$skiptoken=…");
  assert.deepEqual(live.annotations._list_value, ["OData.Community.Display.V1.FormattedValue"]);
  const kinds = compareJson(live, local, { compareValues: true }).map((delta) => delta.kind).sort();
  // @odata.context and @odata.nextLink are both missing locally; statecode differs in type and value.
  assert.deepEqual(kinds, ["annotations", "field-type", "next-link", "top-key-missing", "top-key-missing", "values"].sort());
  const business = projectJson(JSON.stringify({ value: [{ name: "Secret product" }] }));
  assert.equal(business.values, undefined);
  assert.ok(!JSON.stringify(business).includes("Secret product"));
  const error = projectJson(JSON.stringify({ error: { code: "90040120", message: "You don't have permission" } }));
  assert.equal(error.kind, "error");
  assert.equal(error.error.codeShape, "hex8");
  assert.deepEqual(compareJson(error, projectJson(JSON.stringify({ error: { code: "TABLE_PERMISSION_DENIED", message: "Denied" } }))).map((delta) => delta.kind), ["error-code-shape"]);
  assert.deepEqual(compareNetwork([{ method: "GET", url: "/_api/x?$select=…", status: 200, projection: live }], [{ method: "GET", url: "/_api/x?$select=…", status: 200, projection: live }, { method: "GET", url: "/_api/y", status: 404 }]).map((delta) => delta.kind), ["network-extra"]);
});

test("redirect, header, cookie and ETag projections keep shapes without secrets", () => {
  const location = classifyLocation("/en-US/signin?ReturnUrl=%2Fworkspace%2F%3Fparity%3D1", { origin: "https://reference.example" });
  assert.equal(location.signIn, true);
  assert.equal(location.languagePrefix, "en-US");
  assert.equal(location.returnKey, "ReturnUrl");
  assert.equal(location.returnPath, "/workspace/");
  assert.deepEqual(location.returnQueryNames, ["parity"]);
  assert.equal(location.hexCase, "upper");
  assert.equal(location.returnUrlEncoded, "%2Fworkspace%2F%3Fparity%3D…");
  assert.equal(classifyLocation("https://login.example/authorize?state=x", { origin: "https://reference.example" }).kind, "external");
  const headers = projectHeaders({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, no-cache", "Content-Security-Policy": "script-src 'self' 'nonce-abc123'; default-src 'self'", "Set-Cookie": "session=secret" }, ["content-type", "cache-control", "content-security-policy", "set-cookie"]);
  assert.deepEqual(headers["cache-control"], ["no-cache", "no-store"]);
  assert.deepEqual(headers["content-security-policy"]["script-src"], ["'nonce-{redacted}'", "'self'"]);
  assert.equal(headers["set-cookie"], null);
  assert.deepEqual(compareHeaders(headers, { ...headers, "content-security-policy": { "default-src": ["'self'"] } }).map((delta) => delta.kind), ["csp-directive-missing"]);
  const cookies = cookieShapes(["ARRAffinity=abcdef; Path=/; HttpOnly; Secure; SameSite=None", "ContextLanguageCode=en-US; expires=Wed, 01 Jan 2031 00:00:00 GMT; path=/"]);
  assert.deepEqual(cookies.map((cookie) => cookie.name), ["ARRAffinity", "ContextLanguageCode"]);
  assert.ok(!JSON.stringify(cookies).includes("abcdef") && !JSON.stringify(cookies).includes("en-US"));
  assert.deepEqual(etagShape('W/"0x8DE1A2B3C4"'), { weak: true, quoted: true, length: 12, alphabet: "hex" });
});

test("Liquid probes classify literals, masks and concatenated roles", () => {
  assert.equal(classifyLiteral('"" ""').classification, "raw-text");
  assert.equal(classifyLiteral('"1"').classification, "json-string");
  assert.equal(classifyLiteral("1").classification, "json-number");
  assert.equal(classifyLiteral("False").classification, "dotnet-boolean");
  assert.equal(formatMask("10/7/2026 9:41:00 PM"), "99/9/9999 9:99:99 A{2}");
  const probe = extractProbe('<input name="__RequestVerificationToken" type="hidden" value="abc" />', { regex: "(<input[^>]*>)", redactAttributes: ["value"] });
  assert.equal(probe.value, '<input name="__RequestVerificationToken" type="hidden" value="{redacted}" />');
  const roles = ["Authenticated Users", "Review Manager", "Reviewer", "Demo Data Steward"];
  assert.deepEqual(segmentRoles("Review ManagerDemo Data StewardAuthenticated Users", roles), ["Review Manager", "Demo Data Steward", "Authenticated Users"]);
  assert.equal(segmentRoles("Unknown RoleAuthenticated Users", roles), null);
  assert.deepEqual(checkPersonaAccess(["A"], [{ path: "/x/", rolesAny: ["A"], accessible: true }, { path: "/y/", rolesAny: ["B"], accessible: true }]).map((item) => item.consistent), [true, false]);
});

test("run-time identifiers fill placeholders without entering the plan; drift and probe shapes carry no values", async () => {
  const scenario = { id: "x", kind: "page-dom", path: "/requests/details/?id={id}&orderId=1&categoryId={categoryId}", discover: { from: "ids", key: "draft" } };
  assert.doesNotThrow(() => validatePlan({ version: 1, scenarios: [scenario] }));
  assert.equal(scenarioPath(scenario, { id: GUID_A, categoryId: GUID_B }), `/requests/details/?id=${GUID_A}&orderId=1&categoryId=${GUID_B}`);
  const ids = { draft: { live: { id: GUID_A, categoryId: GUID_B }, local: { id: GUID_B } } };
  assert.deepEqual(await __testing.discoverTarget({}, scenario, { side: "live", ids }), { path: `/requests/details/?id=${GUID_A}&orderId=1&categoryId=${GUID_B}` });
  assert.match((await __testing.discoverTarget({}, scenario, { side: "local", ids })).error, /every placeholder/);
  assert.match((await __testing.discoverTarget({}, scenario, { side: "live", ids: { draft: { live: { id: "x\"><script>" } } } })).error, /identifiers/);
  assert.match((await __testing.discoverTarget({}, { ...scenario, path: "/records/approve/?id={id}" }, { side: "live", ids: { draft: { live: { id: GUID_A } } } })).error, /deny list/);
  assert.equal(compareBytes(Buffer.from("a\r\nb\r\n"), Buffer.from("a\nb")), "line-endings");
  assert.equal(compareBytes(Buffer.from("a"), Buffer.from("a")), "identical");
  assert.equal(compareBytes(Buffer.from("a"), Buffer.from("b")), "different");
  assert.equal(letterCase("3f2504e0-4f89"), "lower");
  assert.equal(letterCase("3F2504E0"), "upper");
  assert.equal(letterCase("11111111-1111"), "no-letters");
  assert.equal(tagShape('<div data-xrm-base="/secret/path" class="xrm-attribute xrm-editable-html">'), "div.xrm-attribute.xrm-editable-html[data-xrm-base]");
  assert.equal(tagShape("plain text"), null);
});

test("FetchXML paging rewrites only page and cookie attributes", () => {
  const scenario = { path: "/_api/items", fetchXml: "<fetch count='2' page='1'><entity name='item'/></fetch>" };
  const pathWithCookie = withFetchXmlPage(scenarioPath(scenario), 2, '<cookie page="1"><itemid last="{X}"/></cookie>');
  const xml = new URL(pathWithCookie, "https://x.invalid").searchParams.get("fetchXml");
  assert.equal(xml, `<fetch count='2' page="2" paging-cookie="&lt;cookie page=&quot;1&quot;&gt;&lt;itemid last=&quot;{X}&quot;/&gt;&lt;/cookie&gt;"><entity name='item'/></fetch>`);
});

test("classification rules match scenario, kind, path and field criteria in order", () => {
  const rules = [
    { scenario: "/^anon-/", kind: "redirect", class: "runtime-gap", owner: "D", note: "redirect shape" },
    { kind: "repeat-count", class: "data-difference", note: "row counts follow data" },
  ];
  assert.equal(classifyDelta({ kind: "redirect", field: "path" }, "anon-x", rules).owner, "D");
  assert.equal(classifyDelta({ kind: "redirect" }, "home", rules).class, "unclassified");
  assert.equal(classifyDelta({ kind: "repeat-count" }, "home", rules).class, "data-difference");
});

test("runner compares synthetic loopback sides, classifies deltas, redacts values and never writes", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "parity-suite-"));
  const writes = { live: 0, local: 0 };
  const signIns = [];
  const localCookies = [];
  let identity = { contactId: "local", roles: ["Authenticated Users"] };
  const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
  const serve = async (side) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://x.invalid");
      if (!["GET", "HEAD"].includes(req.method) && !(side === "local" && url.pathname === "/__sim/api/session/sign-in")) {
        writes[side]++;
        res.writeHead(405).end();
        return;
      }
      if (side === "local" && url.pathname === "/__sim/api/state") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ csrf: "csrf", config: { mode: "local", pageMode: "local", endpoints: [], identity, contactRoles: [] }, data: { item: [{ id: 1 }] }, status: { sourceFingerprint: "source", implementationFingerprint: "implementation", effectiveIdentity: identity, webRoles: [{ id: "r1", name: "Authenticated Users" }], sourceDir: null } }));
        return;
      }
      if (side === "local" && url.pathname === "/__sim/api/session") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ signedIn: false, defaultPersona: { contactId: "local-contact" }, cookie: { name: "paqvilo-mirage-auth-test" } }));
        return;
      }
      if (side === "local" && url.pathname === "/__sim/api/session/sign-in") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const request = JSON.parse(body);
        signIns.push({ csrf: req.headers["x-sim-csrf"], contactId: request.contactId, roles: request.roles ?? null });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ signedIn: true, contactId: request.contactId, roles: request.roles ?? ["Authenticated Users"], roleSource: request.roles ? "override" : "memberships", cookie: { name: "paqvilo-mirage-auth-test", value: "signed-local" } }));
        return;
      }
      if (side === "local" && !url.pathname.startsWith("/__sim/")) localCookies.push(`${url.pathname} ${req.headers.cookie ?? "-"}`);
      if (url.pathname === "/workspace/") {
        if (side === "live") res.writeHead(302, { location: "/en-US/signin?ReturnUrl=%2Fworkspace%2F" }).end();
        else res.writeHead(403, { "content-type": "text/html" }).end(page("Portal rendering needs attention", "<h1>Denied</h1>"));
        return;
      }
      if (url.pathname === "/_api/items") {
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ value: [{ id: GUID_A, name: side === "live" ? "Live secret record" : "Local synthetic record" }] }));
        return;
      }
      if (url.pathname === "/_api/blocked") {
        res.writeHead(side === "live" ? 403 : 403, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: side === "live" ? "90040120" : "TABLE_PERMISSION_DENIED", message: "No access" } }));
        return;
      }
      if (url.pathname === "/probe/") {
        res.setHeader("content-type", "text/html");
        res.end(page("Probe", `<script>const headerHtml = ${side === "live" ? '"" ""' : '""'};\nif (headerHtml) {}</script>`));
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("cache-control", side === "live" ? "no-cache, no-store, must-revalidate" : "no-store");
      res.end(page("Home", "<h1>Home</h1>"));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const liveOrigin = await serve("live");
  const localOrigin = await serve("local");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const snapshot = (rows, userName, title = "Home") => ({
    path: "/",
    title,
    roots: [{ selector: "body", count: 1, nodes: [element("body", {}, [element("header", { class: "sample-header" }, [element("span", { class: "user" }, [text(userName)])]), element("table", {}, Array.from({ length: rows }, () => element("tr", {}, [element("td", {}, [text("row")])])))])] }],
    truncated: false,
    nodeCount: 10,
    panel: false,
    signInSignals: { passwordInputs: 0 },
  });
  const fakePages = (rows, userName, title) => async () => ({ status: 200, finalPath: "/", originChanged: false, snapshot: snapshot(rows, userName, title), settled: true, blockedWrites: [], fulfilledWrites: [], consoleErrors: [], pageErrors: [], failedResponses: [], pendingRequests: [], network: [], ms: 1 });
  const liveHttp = createHttpDriver({ origin: liveOrigin, identity: "anonymous" });
  const { createIdentityController } = await import("../parity-suite.mjs");
  const controller = createIdentityController(localOrigin);
  const localHttp = createHttpDriver({ origin: localOrigin, identity: "local", cookie: () => controller.cookie() });
  const plan = {
    version: 1,
    scenarios: [
      { id: "home-dom", kind: "page-dom", path: "/", questions: ["G-X1"] },
      { id: "anon-redirect", kind: "anonymous", path: "/workspace/", questions: ["G-D1"] },
      { id: "api-items", kind: "api-json", identity: "anonymous", path: "/_api/items", referenceData: false },
      { id: "api-blocked", kind: "api-status", identity: "anonymous", path: "/_api/blocked" },
      { id: "api-signed", kind: "api-status", path: "/_api/blocked" },
      { id: "home-headers", kind: "headers", identity: "anonymous", path: "/", headers: ["cache-control"] },
      { id: "probe-json", kind: "liquid-probe", identity: "anonymous", path: "/probe/", probe: { source: "html", regex: "const headerHtml = ([\\s\\S]*?);\\s*if \\(headerHtml", compare: "exact", decode: false } },
    ],
    notObservable: [{ id: "G-W4", reason: "requires a write" }],
    classifications: [
      { kind: "repeat-count", class: "data-difference", note: "Row counts follow the selected data." },
      { scenario: "anon-redirect", class: "runtime-gap", owner: "D", note: "Anonymous restricted pages redirect to sign-in on the reference." },
    ],
  };
  const report = await runParitySuite({
    plan,
    localUrl: localOrigin,
    origin: liveOrigin,
    sides: {
      live: { origin: liveOrigin, page: fakePages(25, "Maria Example Person", "Maria Example Person · Home"), http: liveHttp.http },
      anonymous: { origin: liveOrigin, http: liveHttp.http, page: fakePages(25, "Maria Example Person") },
      local: { origin: localOrigin, http: localHttp.http, page: fakePages(3, "Alex Local") },
    },
    identity: controller,
    outDir: directory,
    delayMs: 0,
  });
  const byId = Object.fromEntries(report.scenarios.map((scenario) => [scenario.id, scenario]));
  assert.equal(byId["anon-redirect"].verdict, "delta");
  assert.deepEqual(byId["anon-redirect"].owners, ["D"]);
  assert.equal(byId["anon-redirect"].observations.redirect.live.location.returnPath, "/workspace/");
  assert.equal(byId["api-items"].verdict, "pass", JSON.stringify(byId["api-items"].deltas));
  assert.deepEqual(byId["api-blocked"].deltas.map((delta) => delta.kind), ["error-code-shape"]);
  assert.deepEqual(byId["home-headers"].deltas.map((delta) => delta.kind), ["header"]);
  assert.deepEqual(byId["probe-json"].deltas.map((delta) => delta.kind), ["probe-text"]);
  const homeKinds = byId["home-dom"].deltas.map((delta) => delta.kind).sort();
  assert.deepEqual(homeKinds, ["repeat-count", "text"]);
  assert.equal(byId["home-dom"].deltas.find((delta) => delta.kind === "text").classification.class, "unclassified");
  assert.equal(report.localDataUnchanged, true);
  // Live page titles can name records: only source-derived or local-equal titles are kept.
  assert.equal(byId["home-dom"].observations.live.title.redacted, true);
  assert.equal(byId["home-dom"].observations.local.title, "Home");
  assert.deepEqual(report.questions["G-D1"], [{ scenario: "anon-redirect", verdict: "delta" }]);
  assert.equal(report.questionsNotObservable[0].id, "G-W4");
  assert.deepEqual(writes, { live: 0, local: 0 });
  // Local identity is a session cookie: one sign-in through the session API (no configuration
  // change), the cookie on signed-in local requests and none on anonymous ones.
  assert.deepEqual(signIns, [{ csrf: "csrf", contactId: "local-contact", roles: null }]);
  assert.ok(localCookies.includes("/_api/blocked paqvilo-mirage-auth-test=signed-local"), localCookies.join("; "));
  assert.ok(localCookies.includes("/_api/blocked -"), localCookies.join("; "));
  assert.ok(localCookies.includes("/_api/items -"), localCookies.join("; "));
  assert.equal(byId["api-signed"].localIdentity.identity, "signed-in");
  assert.equal(byId["api-items"].localIdentity.identity, "anonymous");
  const saved = (await fs.readFile(path.join(directory, "report.json"), "utf8")) + (await fs.readFile(path.join(directory, "summary.md"), "utf8"));
  for (const secret of ["Maria Example Person", "Live secret record", "csrf"]) assert.ok(!saved.includes(secret), secret);
  assert.ok(saved.includes("Alex Local"), "local synthetic values remain readable");
  const live = JSON.parse(await fs.readFile(path.join(directory, "scenarios", "home-dom", "root-1.live.json"), "utf8"));
  assert.ok(!JSON.stringify(live).includes("Maria"));
  assert.match(summaryMarkdown(report), /anon-redirect \| anonymous/);
});

test("scenario sources combine the core set with matching data-pack plans and scope each plan's rules", async (t) => {
  const { packScenarioFiles, scenarioSources, mergePlans, loadScenarioPlans, rulesFor, classifyDelta, CORE_SCENARIOS_FILE } = await import("../parity-suite.mjs");
  // Pack contract: relative .json plan files inside the pack directory only.
  const packDir = path.join(os.tmpdir(), "pack-dir");
  assert.deepEqual(packScenarioFiles({ id: "demo" }, packDir), []);
  assert.deepEqual(packScenarioFiles({ id: "demo", parity: { scenarios: ["fixtures/demo.json"] } }, packDir), [path.join(packDir, "fixtures", "demo.json")]);
  for (const entry of ["../outside.json", path.join(packDir, "absolute.json"), "fixtures/demo.txt", "file:demo.json"])
    assert.throws(() => packScenarioFiles({ id: "demo", parity: { scenarios: [entry] } }, packDir), /relative \.json|leaves the pack/, entry);
  assert.throws(() => packScenarioFiles({ id: "demo", parity: { scenarios: "fixtures/demo.json" } }, packDir), /must be an array/);

  // A temporary packs root with one pack that matches only its own portal.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parity-packs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "demo-parity", "fixtures"), { recursive: true });
  await fs.writeFile(
    path.join(root, "demo-parity", "pack.mjs"),
    'export default { id: "demo-parity", name: "Demo", description: "Synthetic parity pack.", matches: ({ portal } = {}) => portal?.website?.name === "demo", presets: () => ({}), parity: { scenarios: ["fixtures/demo.json"] } };\n',
  );
  const demoPlan = {
    version: 1,
    defaults: { delayMs: 50 },
    scenarios: [{ id: "demo-home", kind: "anonymous", path: "/" }],
    classifications: [{ id: "demo-any", class: "runtime-gap", owner: "D", note: "Demo rule." }],
  };
  await fs.writeFile(path.join(root, "demo-parity", "fixtures", "demo.json"), JSON.stringify(demoPlan));
  const sources = async (options) => (await scenarioSources({ packsRoot: root, ...options })).map((item) => item.source);
  assert.deepEqual(await sources({ portal: { website: { name: "demo" } } }), ["core", "pack:demo-parity"]);
  assert.deepEqual(await sources({ portal: { website: { name: "other" } } }), ["core"]);
  assert.deepEqual(await sources({ portal: null }), ["core"]);
  assert.deepEqual(await sources({ packs: ["demo-parity"], core: false }), ["pack:demo-parity"]);
  assert.deepEqual(await sources({ packs: "none" }), ["core"]);
  await assert.rejects(scenarioSources({ packsRoot: root, packs: ["missing-pack"] }), /was not found/);
  await assert.rejects(scenarioSources({ packsRoot: root, packs: "some" }), /auto, all, none/);

  const merged = await loadScenarioPlans({ packsRoot: root, portal: { website: { name: "demo" } } });
  const core = JSON.parse(await fs.readFile(CORE_SCENARIOS_FILE, "utf8"));
  assert.equal(merged.scenarios.length, core.scenarios.length + 1);
  assert.deepEqual(merged.sources.map((item) => [item.source, item.file, item.scenarios]), [["core", "parity-core-scenarios.json", core.scenarios.length], ["pack:demo-parity", "demo.json", 1]]);
  assert.equal(merged.defaults.delayMs, 50, "later sources refine earlier defaults");
  const demo = merged.scenarios.find((scenario) => scenario.id === "demo-home");
  const coreHome = merged.scenarios.find((scenario) => scenario.id === "core-home");
  assert.equal(demo.planSource, "pack:demo-parity");
  assert.equal(coreHome.planSource, "core");
  // A plan's rules classify only its own scenarios.
  assert.equal(classifyDelta({ kind: "status" }, demo.id, rulesFor(merged, demo)).rule, "demo-any");
  assert.equal(classifyDelta({ kind: "status" }, coreHome.id, rulesFor(merged, coreHome)).rule, "core-routing");
  // Duplicate ids across sources are refused; a single explicit plan file is used unchanged.
  assert.throws(() => mergePlans([{ source: "core", file: "a.json", plan: demoPlan }, { source: "pack:x", file: "b.json", plan: demoPlan }]), /defined by core and pack:x/);
  const single = mergePlans([{ source: "file", file: "demo.json", plan: demoPlan }]);
  assert.equal(single.scenarios[0].planSource, undefined);
  assert.equal(single.classifications[0].planSource, undefined);
  assert.equal(single.sources, undefined);
});

test("portal discovery picks deterministic anonymous targets, and the core set validates", async () => {
  const { portalDiscovery, validatePlan, loadScenarioPlans, scenarioPath, PORTAL_DISCOVERY } = await import("../parity-suite.mjs");
  const portal = {
    pages: [
      { id: "home", url: "/" },
      { id: "z", url: "/zeta/" },
      { id: "a", url: "/alpha/" },
      { id: "d", url: "/alpha/deeper/" },
      { id: "u", url: "/draft/" },
    ],
    webFiles: [
      { id: "f1", url: "/theme.css" },
      { id: "f2", url: "/private.css" },
      { id: "f3", url: "/logo.png" },
    ],
    settings: { "Webapi/sample_item/enabled": "true", "Webapi/sample_item/fields": "sample_name,sample_itemid", "Webapi/contact/enabled": { value: "false" }, "Webapi/sample_other/enabled": "false" },
  };
  const codes = { "/zeta/": "PAGE_ACCESS_DENIED", "/alpha/": "PAGE_ACCESS_DENIED", "/alpha/deeper/": "PAGE_ACCESS_DENIED", "/draft/": "PAGE_UNPUBLISHED", "/private.css": "PAGE_ACCESS_DENIED" };
  const pageAccess = (_portal, target, identity) => {
    assert.deepEqual(identity, {}, "evaluated for an anonymous visitor");
    return codes[target.url] ? { allowed: false, code: codes[target.url] } : { allowed: true };
  };
  const mappings = { sample_item: { entitySet: "sample_items", idColumn: "sample_itemid" }, sample_other: { entitySet: "sample_others", idColumn: "sample_otherid" }, contact: { entitySet: "contacts" } };
  assert.deepEqual(portalDiscovery({ portal, mappings, pageAccess }), {
    protectedPage: "/alpha/",
    publicWebFile: "/theme.css",
    publicWebFiles: ["/theme.css"],
    enabledEntitySet: "sample_items",
    enabledField: "sample_itemid",
    enabledTable: "sample_item",
    notEnabledEntitySet: "sample_others",
    notEnabledTable: "sample_other",
  });
  assert.deepEqual(portalDiscovery({ portal: { pages: [{ id: "home", url: "/" }], webFiles: [], settings: {} }, mappings: {}, pageAccess }), {});
  // Without the primary key in the allowed columns, the first listed column is used; pluralised or
  // relationship-only mappings are not candidates for the not-enabled table.
  const narrow = portalDiscovery({ portal: { ...portal, settings: { "Webapi/sample_item/enabled": "true", "Webapi/sample_item/fields": "sample_name" } }, mappings: { ...mappings, sample_other: { ...mappings.sample_other, entitySetSource: "pluralized" }, sample__link: { entitySet: "sample__links" } }, pageAccess });
  assert.equal(narrow.enabledField, "sample_name");
  assert.equal(narrow.notEnabledEntitySet, undefined);
  // Portal discovery fills placeholders; unknown keys and paths without placeholders are refused.
  const scenario = { id: "x", kind: "anonymous", path: "{protectedPage}?parity=1", discover: { from: "portal", keys: ["protectedPage"] } };
  assert.equal(scenarioPath(scenario, { protectedPage: "/alpha/" }), "/alpha/?parity=1");
  validatePlan({ version: 1, scenarios: [scenario] });
  assert.throws(() => validatePlan({ version: 1, scenarios: [{ ...scenario, discover: { from: "portal", keys: ["unknownKey"] } }] }), /known keys/);
  assert.throws(() => validatePlan({ version: 1, scenarios: [{ ...scenario, path: "/fixed/" }] }), /needs placeholders/);
  // A URL shared by pages with different anonymous access is reported separately and never used
  // for the redirect checks.
  const shared = portalDiscovery({
    portal: { pages: [{ id: "p1", url: "/dup/" }, { id: "p2", url: "/dup/" }, { id: "p3", url: "/only/" }], webFiles: [], settings: {} },
    mappings: {},
    pageAccess: (_portal, target) => (target.id === "p1" ? { allowed: true } : { allowed: false, code: "PAGE_ACCESS_DENIED" }),
  });
  assert.deepEqual(shared, { protectedPage: "/only/", ambiguousPage: "/dup/" });
  // A stylesheet the reference home page loaded is preferred; a missing value is not applicable.
  const { __testing } = await import("../parity-suite.mjs");
  const webFile = { id: "w", kind: "headers", identity: "anonymous", path: "{publicWebFile}", discover: { from: "portal", keys: ["publicWebFile"] } };
  const facts = { publicWebFile: "/a.css", publicWebFiles: ["/a.css", "/b.css"] };
  assert.deepEqual(await __testing.discoverTarget(null, webFile, { portal: facts, liveAssets: new Set(["/b.css"]) }), { path: "/b.css" });
  assert.deepEqual(await __testing.discoverTarget(null, webFile, { portal: facts }), { path: "/a.css" });
  assert.equal((await __testing.discoverTarget(null, webFile, { portal: {} })).notApplicable, true);
  // The core set is anonymous and uses only known discovery keys.
  const core = await loadScenarioPlans({ packs: "none" });
  for (const item of core.scenarios) for (const key of item.discover?.keys ?? []) assert.ok(Object.hasOwn(PORTAL_DISCOVERY, key), key);
  assert.ok(core.scenarios.every((item) => (item.identity ?? (item.kind === "anonymous" ? "anonymous" : "signed-in")) === "anonymous"), "the core set is anonymous");
});

test("document shells compare the title, html/body attributes and bundle presence and order", async () => {
  const { compareShell } = await import("../parity-suite.mjs");
  const live = {
    title: "Home · Site",
    html: [["lang", "en-US"]],
    body: [["class", "home  page"], ["data-sitemap-state", "/"], ["data-dateformat", "dd/MM/yyyy"]],
    resources: [
      { kind: "stylesheet", path: "/bootstrap.min.css" },
      { kind: "script", path: "/_portal/7a1b2c3d-1111-2222-3333-444455556666/js/bundle.js" },
      { kind: "script", path: "/jquery.js" },
      { kind: "script", path: "/site.js" },
    ],
  };
  const local = {
    title: "Home · Site",
    html: [["lang", "en-US"], ["data-sim", "1"]],
    body: [["class", "page home extra"], ["data-sitemap-state", "/other"]],
    resources: [
      { kind: "stylesheet", path: "/bootstrap.min.css" },
      { kind: "script", path: "/jquery.js" },
      { kind: "script", path: "/_portal/0f0e0d0c-aaaa-bbbb-cccc-ddddeeeeffff/js/bundle.js" },
      { kind: "script", path: "/__sim-static/vendor/compat.js" },
    ],
  };
  const { deltas, live: liveView } = compareShell(live, local);
  assert.deepEqual(deltas.map((delta) => `${delta.kind}:${delta.attribute ?? delta.path}`).sort(), [
    "attribute-extra:data-sim",
    "attribute-missing:data-dateformat",
    "attribute-value:data-sitemap-state",
    "bundle-extra:script /__sim-static/vendor/compat.js",
    "bundle-missing:script /site.js",
    "bundle-order:shared bundle 2 of 3",
    "class:body",
  ]);
  assert.equal(deltas.find((delta) => delta.kind === "class").local, "extra");
  assert.equal(liveView.resources[1], "script /_portal/{guid}/js/bundle.js", "GUIDs are normalised in bundle keys");
  assert.deepEqual(compareShell(live, live).deltas, []);
  // CDN platform bundles and their local copies share one path; content hashes are deployment
  // state; hosted services are reported separately and take no part in the bundle order.
  const cdn = (path) => ({ kind: "script", path: "https://content.powerapps.com/resource/powerappsportal/" + path });
  const copy = (path) => ({ kind: "script", path: "/resource/powerappsportal/" + path });
  const hostedLive = { ...live, resources: [cdn("dist/app.bundle-79acd4df74.js"), { kind: "script", path: "https://js.monitor.azure.com/scripts/b/ai.2.min.js" }, cdn("controls/host/main.8512520686.chunk.js")] };
  const hostedLocal = { ...live, resources: [copy("dist/app.bundle-0123abcd99.js"), copy("controls/host/main.3ee2491f78.chunk.js")] };
  assert.deepEqual(compareShell(hostedLive, hostedLocal).deltas.map((delta) => `${delta.kind}:${delta.path}`), ["hosted-resource-missing:script https://js.monitor.azure.com/scripts/b/ai.2.min.js"]);
});

test("local identity mirrors the reference persona with a session role override and changes no runtime state", async (t) => {
  const { createIdentityController } = await import("../parity-suite.mjs");
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/__sim/api/state")) {
      res.end(JSON.stringify({ csrf: "token", status: { webRoles: [{ name: "Authenticated Users" }, { name: "Reviewer" }] } }));
      return;
    }
    if (req.method === "POST" && req.url === "/__sim/api/session/sign-in" && req.headers["x-sim-csrf"] === "token") {
      const request = JSON.parse(body);
      res.end(JSON.stringify({ signedIn: true, contactId: request.contactId, roles: request.roles, roleSource: "override", cookie: { name: "paqvilo-mirage-auth-1", value: "v" } }));
      return;
    }
    res.writeHead(404).end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const controller = createIdentityController(`http://127.0.0.1:${server.address().port}`);
  assert.equal(controller.cookie(), null);
  const mirrored = await controller.mirror({ contactId: "c-1", roles: ["Authenticated Users", "Reviewer", "Unknown Role"] });
  assert.deepEqual(mirrored, { unresolved: ["Unknown Role"], effectiveRoles: ["Authenticated Users", "Reviewer"], contactPresent: true, session: "override" });
  assert.deepEqual(controller.cookie(), { name: "paqvilo-mirage-auth-1", value: "v" });
  await controller.use("anonymous");
  assert.equal(controller.cookie(), null);
  await controller.use("signed-in");
  assert.deepEqual(controller.cookie(), { name: "paqvilo-mirage-auth-1", value: "v" });
  assert.equal(controller.describe().session, "override");
  await controller.restore();
  assert.deepEqual(requests.filter((request) => !request.startsWith("GET /__sim/api/state")), ["POST /__sim/api/session/sign-in"]);
  assert.throws(() => createIdentityController("http://example.com:8080"), /loopback/);
});

test("blocked request bodies keep only their top-level keys and the GUIDs they name", async () => {
  const { bodyShape } = await import("../parity-suite.mjs");
  assert.deepEqual(bodyShape(JSON.stringify({ viewId: "0AB12345-1111-2222-3333-444455556666", search: "secret value", page: 1 })), {
    keys: ["page", "search", "viewId"],
    guids: ["0ab12345-1111-2222-3333-444455556666"],
  });
  assert.deepEqual(bodyShape("field=value"), { keys: null, guids: [] });
  assert.equal(bodyShape(""), undefined);
});

test("captures that never settled, or anonymous ones naming a portal user, are blocked, also on reclassify", async () => {
  const { captureProblem, reclassifyReport, loadScenarioPlans } = await import("../parity-suite.mjs");
  const view = (settled, nodeCount, portalUser) => ({ settled, snapshot: { nodeCount, signInSignals: { passwordInputs: 0, portalUser } } });
  assert.equal(captureProblem("anonymous", view(true, 30, false)), null);
  assert.equal(captureProblem("anonymous", view(true, 30, null)), null, "pages without the platform client object are compared");
  assert.equal(captureProblem("signed-in", view(false, 30, true)), null, "an unsettled capture with nodes is still compared");
  assert.match(captureProblem("signed-in", view(false, 0, null)), /neither settled nor produced a snapshot/);
  assert.match(captureProblem("anonymous", view(true, 30, true)), /signed-in portal user/);
  assert.equal(captureProblem("signed-in", view(true, 30, true)), null);
  // Saved page diagnostics carry the node count and the portal-user flag directly.
  assert.match(captureProblem("anonymous", { status: 200, settled: true, nodeCount: 30, portalUser: true }), /--anonymous-browser owned/);
  const plan = await loadScenarioPlans({ core: true, packs: "none" });
  const saved = (id, live) => ({
    id,
    kind: "page-dom",
    identity: "anonymous",
    verdict: "pass-with-expected-deltas",
    deltas: [{ kind: "text", path: "body>main>#text", live: "a", local: "b" }],
    observations: { live, local: { status: 200, settled: true, nodeCount: 30, portalUser: false } },
  });
  const report = reclassifyReport(
    {
      label: "saved",
      scenarios: [
        saved("core-home", { status: 200, settled: true, nodeCount: 30, portalUser: true }),
        saved("core-not-found", { status: 404, settled: false, nodeCount: 0 }),
        saved("core-ambiguous-url", { status: 200, settled: true, nodeCount: 30, portalUser: false }),
      ],
    },
    plan,
  );
  assert.deepEqual(report.scenarios.slice(0, 2).map((scenario) => scenario.verdict), ["blocked", "blocked"]);
  assert.match(report.scenarios[0].reason, /signed-in portal user/);
  assert.match(report.scenarios[1].reason, /neither settled/);
  assert.notEqual(report.scenarios[2].verdict, "blocked");
  assert.equal(report.totals.blocked, 2);
});

test("client objects compare key presence, key order, value types and empty User values, never values", async () => {
  const { compareClientObject, validatePlan, loadScenarioPlans } = await import("../parity-suite.mjs");
  const entry = (key, type, empty) => (empty === undefined ? { key, type } : { key, type, empty });
  const live = {
    microsoft: [entry("Dynamic365", "object"), entry("PowerPages", "object"), entry("ApplicationInsights2", "object")],
    dynamic365: [entry("Portal", "object")],
    portal: [entry("User", "object"), entry("type", "string"), entry("id", "string")],
    user: [entry("userName", "string", true), entry("contactId", "string", true), entry("userRoles", "array", true)],
    powerPages: [entry("onPagesClientApiReady", "function")],
  };
  assert.deepEqual(compareClientObject(live, structuredClone(live)), []);
  const local = {
    microsoft: [entry("Dynamic365", "object"), entry("PowerPages", "object")],
    dynamic365: [entry("Portal", "object")],
    portal: [entry("id", "string"), entry("User", "object"), entry("type", "string"), entry("version", "string")],
    user: [entry("userName", "string", true), entry("contactId", "null"), entry("userRoles", "array", false)],
    powerPages: null,
  };
  assert.deepEqual(
    compareClientObject(live, local).map((delta) => `${delta.kind} ${delta.path} ${delta.live} ${delta.local}`),
    [
      "client-key-missing Microsoft.ApplicationInsights2 object null",
      "client-key-extra Microsoft.Dynamic365.Portal.version null string",
      "client-key-order Microsoft.Dynamic365.Portal User,type,id id,User,type",
      "client-key-type Microsoft.Dynamic365.Portal.User.contactId string null",
      "client-value-empty Microsoft.Dynamic365.Portal.User.userRoles true false",
      "client-object-missing Microsoft.PowerPages true false",
    ],
  );
  const plan = await loadScenarioPlans({ core: true, packs: "none" });
  validatePlan(plan);
  assert.equal(plan.scenarios.find((scenario) => scenario.id === "core-client-object").kind, "client-object");
});

test("a plan denies its own routes, a matching pack's denied routes guard every run, and no validation lifts a denial", async (t) => {
  const { validatePlan, mergePlans, assertReadOnlyPath, activatePackDeniedRoutes, __testing } = await import("../parity-suite.mjs");
  const base = { version: 1, scenarios: [{ id: "a", kind: "page-dom", path: "/" }] };
  const route = { pattern: "/synthetic-orders/new-order(?:[/?]|$)", reason: "Loading the page creates a draft order." };
  assert.throws(() => validatePlan({ ...base, deniedRoutes: [{ pattern: route.pattern }] }), /documented reason/);
  assert.throws(() => validatePlan({ ...base, deniedRoutes: [{ pattern: "(", reason: route.reason }] }), /not a valid regular expression/);
  assert.throws(() => validatePlan({ ...base, deniedRoutes: route }), /must be an array/);
  // A scenario on a route its own plan denies is refused before any request.
  assert.throws(() => validatePlan({ ...base, scenarios: [{ id: "a", kind: "page-dom", path: "/synthetic-orders/new-order/" }], deniedRoutes: [route] }), /deny list/);
  assert.doesNotThrow(() => assertReadOnlyPath("/synthetic-orders/new-order/"), "a refused plan denies nothing");
  validatePlan({ ...base, deniedRoutes: [route] });
  assert.throws(() => assertReadOnlyPath("/synthetic-orders/new-order/?id=1"), /deny list/);
  validatePlan(base);
  assert.throws(() => assertReadOnlyPath("/Synthetic-Orders/New-Order"), /deny list/, "validating another plan keeps the denial");
  const discovered = { id: "x", kind: "page-dom", path: "/synthetic-orders/new-order/?id={id}", discover: { from: "ids", key: "draft" } };
  assert.match((await __testing.discoverTarget({}, discovered, { side: "live", ids: { draft: { live: { id: GUID_A } } } })).error, /deny list/);
  // Merged plans keep each denied route once.
  const other = { version: 1, scenarios: [{ id: "b", kind: "page-dom", path: "/b/" }], deniedRoutes: [route] };
  assert.deepEqual(mergePlans([{ source: "core", file: "a.json", plan: { ...base, deniedRoutes: [route] } }, { source: "pack:x", file: "b.json", plan: other }]).deniedRoutes, [route]);

  // A pack's denied routes apply to runs against the portal it matches, whatever scenarios run.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "parity-denied-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "denied-pack", "fixtures"), { recursive: true });
  await fs.writeFile(
    path.join(root, "denied-pack", "pack.mjs"),
    'export default { id: "denied-pack", name: "Denied", description: "Synthetic pack with a denied route.", matches: ({ portal } = {}) => portal?.website?.name === "denied", presets: () => ({}), parity: { scenarios: ["fixtures/plan.json"] } };\n'
  );
  const exportsRoute = { pattern: "/synthetic-exports(?:[/?]|$)", reason: "Requests an export of the record." };
  await fs.writeFile(path.join(root, "denied-pack", "fixtures", "plan.json"), JSON.stringify({ version: 1, scenarios: [{ id: "d", kind: "anonymous", path: "/" }], deniedRoutes: [exportsRoute] }));
  await activatePackDeniedRoutes({ website: { name: "other" } }, { packsRoot: root });
  assert.doesNotThrow(() => assertReadOnlyPath("/synthetic-exports/"), "a pack for another portal does not apply");
  await activatePackDeniedRoutes({ website: { name: "denied" } }, { packsRoot: root });
  assert.throws(() => assertReadOnlyPath("/synthetic-exports/?id=1"), /deny list/);
});

test("the reference sees only GET and HEAD: the fixed allow-list is empty and no plan can widen it", async () => {
  const { SAFE_REFERENCE_REQUESTS, loadScenarioPlans } = await import("../parity-suite.mjs");
  assert.deepEqual(SAFE_REFERENCE_REQUESTS, []);
  assert.ok(Object.isFrozen(SAFE_REFERENCE_REQUESTS));
  const origin = "https://reference.example";
  const origins = [origin];
  const allowList = [{ method: "POST", pathPrefix: "/", reason: "a plan that tries to allow every POST" }];
  const targets = ["/_api/contacts(00000000-0000-0000-0000-000000000001)", "/_api/sample_applications", "/_services/entity-grid-data.json/1", "/filteritemselection/", "/"];
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "MERGE", "OPTIONS"])
    for (const target of targets) {
      assert.equal(requestDecision(method, origin + target, { allowList, origins }).action, "block", `${method} ${target}`);
      assert.equal(isAllowedRequest(method, origin + target, { allowList, origins }).allowed, false, `${method} ${target}`);
    }
  for (const method of ["GET", "HEAD"]) assert.equal(requestDecision(method, origin + "/_api/contacts", { origins }).action, "continue");
  // A write a page issues to /_api is answered locally by a fulfilment rule; it is never sent.
  const fulfil = [{ method: "PATCH", pathPattern: "^/_api/contacts\\(", status: 204, reason: "documented local answer" }];
  assert.deepEqual(requestDecision("PATCH", origin + "/_api/contacts(00000000-0000-0000-0000-000000000001)", { fulfil, origins }), { action: "fulfil", status: 204, rule: "^/_api/contacts\\(" });
  assert.equal(requestDecision("POST", origin + "/_api/contacts", { fulfil, origins }).action, "block");
  // The generic shipped plan cannot widen the read-only reference contract.
  const plan = await loadScenarioPlans({ core: true, packs: "all" });
  validatePlan(plan);
  assert.deepEqual(plan.allowPost, []);
});
