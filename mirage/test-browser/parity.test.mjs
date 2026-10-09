// Verifier regression: synthetic loopback sites and an owned browser identity only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { verifyParity } from "../verify.mjs";

test(
  "parity verifies exact pixels and DOM, rejects mismatches/sign-in/runtime issues, preserves attached browser",
  { timeout: 90_000 },
  async (t) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "paqvilo-mirage-parity-"),
    );
    const body =
      '<!doctype html><html lang="en"><head><title>Portal</title><style>body{font:16px Arial;margin:30px;background:white}h1{color:#223344}</style></head><body><h1>Portal workspace</h1><p>Same rendered output</p><a href="/route/">A route</a></body></html>';
    let mode = "same";
    let writes = 0;
    let stalledFontRequests = 0;
    let sourceChanged = false;
    const servers = [];
    const serve = async (local) => {
      const server = http.createServer((req, res) => {
        if (!req.url.startsWith("/")) {
          res.writeHead(403).end();
          return;
        }
        if (req.url === "/worker.js") {
          res.setHeader("Content-Type", "text/javascript");
          res.end('self.addEventListener("fetch", () => {});');
          return;
        }
        if (req.url === "/slow-font.woff2") {
          stalledFontRequests++;
          return;
        }
        if (local && req.url === "/__sim/events") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(": connected\n\n");
          return;
        }
        if (!["GET", "HEAD"].includes(req.method)) {
          writes++;
          res.end("should not occur");
          return;
        }
        if (req.url === "/__sim/api/state") {
          res.setHeader("Content-Type", "application/json");
          const sourceFingerprint =
            mode === "source-change" && sourceChanged
              ? "changed-source"
              : "fixture-source";
          if (mode === "source-change") sourceChanged = true;
          res.end(
            JSON.stringify({
              config: {
                mode: "local",
                pageMode: mode === "passthrough" ? "live" : "local",
              },
              status: {
                revision: 1,
                implementationFingerprint:
                  mode === "missing-implementation"
                    ? null
                    : "fixture-implementation",
                sourceFingerprint:
                  mode === "missing-source" ? null : sourceFingerprint,
              },
              diagnostics:
                mode === "diagnostic"
                  ? [
                      {
                        code: "unsupported-tag",
                        message: "Cannot simulate tag.",
                      },
                    ]
                  : [],
            }),
          );
          return;
        }
        res.setHeader("Content-Type", "text/html");
        let html = body;
        if (local && mode === "different")
          html = body.replace("Same rendered output", "Different output");
        if (mode === "signin")
          html =
            '<!doctype html><title>Sign in</title><form><input type="password"></form>';
        if (mode === "hidden-password")
          html = body.replace(
            "</body>",
            '<input type="password" style="display:none"></body>',
          );
        if (!local && mode === "toolkit-panel")
          html = body.replace(
            "<body>",
            '<body><div id="paqvilo-panel" style="position:fixed;top:0;right:0;width:60px;height:60px;background:#f00">panel</div>',
          );
        if (mode === "signredirect") {
          if (!req.url.startsWith("/signin/")) {
            res
              .writeHead(302, {
                Location: "/signin/?code=private-auth-code-012345",
              })
              .end();
            return;
          }
          html =
            '<!doctype html><title>Sign in</title><form><input type="password"></form>';
        }
        if (local && mode === "console")
          html = body.replace(
            "</body>",
            '<script>console.error("render error")</script></body>',
          );
        if (local && mode === "write")
          html = body.replace(
            "</body>",
            '<script>fetch("/save",{method:"POST"}).catch(()=>{});fetch("/preflight",{method:"OPTIONS"}).catch(()=>{})</script></body>',
          );
        if (local && mode === "redaction")
          html = body.replace(
            "</body>",
            '<script>console.error("Bearer private-bearer-012345");fetch("/missing?access_token=private-request-token-012345").catch(()=>{})</script></body>',
          );
        if (mode === "session-marker")
          html = body.replace(
            "</body>",
            '<script>if(sessionStorage.getItem("contactCookiesAccepted")!=="true")console.error("session marker missing")</script></body>',
          );
        if (local && mode === "persistent-eventstream")
          html = body.replace(
            "</body>",
            '<script>window.testEvents=new EventSource("/__sim/events")</script></body>',
          );
        if (local && mode === "slow-font")
          html = html.replace(
            "</head>",
            '<style>@font-face{font-family:SlowFont;src:url("/slow-font.woff2") format("woff2")}body{font-family:SlowFont}</style></head>',
          );
        if (req.url.startsWith("/missing")) {
          res.writeHead(404).end("Missing");
          return;
        }
        res.end(html);
      });
      server.on("connect", (_req, socket) => {
        socket.on("error", () => {});
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      servers.push(server);
      return `http://127.0.0.1:${server.address().port}`;
    };
    const liveOrigin = await serve(false);
    const localOrigin = await serve(true);
    let context;
    t.after(async () => {
      await context?.close();
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      await fs.rm(directory, { recursive: true, force: true });
    });
    const profile = path.join(directory, "profile");
    context = await chromium.launchPersistentContext(profile, browserLaunchOptions({
      headless: true,
      args: [
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
      ],
    }));
    const userPage = context.pages()[0];
    await userPage.goto(localOrigin);
    const debugging = (
      await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")
    )
      .trim()
      .split("\n");
    const cdpUrl = `http://127.0.0.1:${debugging[0]}`;
    const verify = (name, options = {}) =>
      verifyParity({
        localUrl: localOrigin,
        origin: liveOrigin,
        cdpUrl,
        path: "/",
        outputDir: path.join(directory, name),
        viewport: { width: 800, height: 600 },
        settleMs: 0,
        timeout: 8000,
        allowLoopbackLive: true,
        ...options,
      });
    // Tabs closed through another CDP connection disappear from this context asynchronously.
    const ownedTabsClosed = async () => {
      for (let attempt = 0; attempt < 50 && context.pages().length > 1; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 100));
      return context.pages().length;
    };
    let result = await verify("same");
    assert.equal(result.passed, true, JSON.stringify(result.differences));
    assert.equal(result.pixels.different, 0);
    assert.equal(result.local.semanticDomSha256, result.live.semanticDomSha256);
    assert.equal(await ownedTabsClosed(), 1);
    assert.equal(await userPage.title(), "Portal");
    assert.ok(await fs.stat(result.artifacts.difference));
    mode = "different";
    result = await verify("different");
    assert.equal(result.passed, false);
    assert.ok(result.pixels.different > 0);
    assert.ok(result.differences.includes("Semantic DOM differs."));
    mode = "signin";
    result = await verify("signin");
    assert.equal(result.passed, false);
    assert.equal(result.pixels.different, 0);
    assert.equal(result.local.signIn, true);
    mode = "hidden-password";
    result = await verify("hidden-password");
    assert.equal(result.passed, true, JSON.stringify(result.differences));
    assert.equal(result.live.signIn, false);
    mode = "toolkit-panel";
    result = await verify("toolkit-panel");
    assert.equal(result.passed, true, JSON.stringify(result.differences));
    assert.equal(result.pixels.different, 0);
    mode = "session-marker";
    result = await verify("session-marker", {
      sessionStorageSeeds: { contactCookiesAccepted: "true" },
    });
    assert.equal(result.passed, true, JSON.stringify(result.differences));
    assert.deepEqual(result.comparison.sessionStorageKeys, ["contactCookiesAccepted"]);
    assert.deepEqual(result.live.consoleErrors, []);
    assert.deepEqual(result.local.consoleErrors, []);
    mode = "persistent-eventstream";
    result = await verify("persistent-eventstream");
    assert.equal(result.passed, true, JSON.stringify(result.differences));
    assert.equal(result.local.quiescent, true);
    assert.equal(result.local.persistentConnections.length, 1);
    assert.deepEqual(result.local.pendingRequests, []);
    mode = "slow-font";
    const fontWaitStarted = Date.now();
    result = await verify("slow-font");
    assert.equal(result.passed, false);
    assert.ok(stalledFontRequests > 0);
    assert.equal(result.local.fontsReady, false);
    assert.ok(result.local.readinessFailures.some((item) => item.includes("Document fonts did not settle")));
    assert.ok(result.local.pendingRequests.some((item) => item.url.includes("slow-font.woff2")));
    assert.ok(Date.now() - fontWaitStarted < 25_000, `font readiness wait must remain bounded (elapsed=${Date.now() - fontWaitStarted}ms)`);
    mode = "console";
    result = await verify("console");
    assert.equal(result.passed, false);
    assert.deepEqual(result.local.consoleErrors, ["render error"]);
    mode = "write";
    result = await verify("write");
    assert.equal(result.passed, false);
    assert.deepEqual(
      result.local.blockedWrites.map(({ method }) => method).sort(),
      ["OPTIONS", "POST"],
    );
    assert.equal(writes, 0);
    mode = "diagnostic";
    result = await verify("diagnostic");
    assert.equal(result.passed, false);
    assert.equal(result.simulator.diagnostics.length, 1);
    mode = "passthrough";
    result = await verify("passthrough");
    assert.equal(result.passed, false);
    assert.ok(
      result.differences.some((item) => item.includes("live page passthrough")),
    );
    mode = "signredirect";
    result = await verify("signredirect");
    assert.equal(result.passed, false);
    assert.ok(!JSON.stringify(result).includes("private-auth-code"));
    assert.equal(result.live.finalUrl, `${liveOrigin}/signin/`);
    mode = "redaction";
    result = await verify("redaction");
    assert.equal(result.passed, false);
    assert.ok(!JSON.stringify(result).includes("private-request-token"));
    assert.ok(!JSON.stringify(result).includes("private-bearer"));
    mode = "source-change";
    result = await verify("source-change");
    assert.equal(result.passed, false);
    assert.ok(
      result.differences.some((item) =>
        item.includes("source fingerprint changed"),
      ),
    );
    mode = "missing-source";
    result = await verify("missing-source");
    assert.equal(result.passed, false);
    assert.ok(
      result.differences.some((item) =>
        item.includes("source fingerprint is unavailable"),
      ),
    );
    mode = "missing-implementation";
    result = await verify("missing-implementation");
    assert.equal(result.passed, false);
    assert.ok(
      result.differences.some((item) =>
        item.includes("implementation fingerprint is unavailable"),
      ),
    );
    mode = "same";
    await userPage.evaluate(async () => {
      await navigator.serviceWorker.register("/worker.js");
      await navigator.serviceWorker.ready;
    });
    result = await verify("serviceworker");
    assert.equal(result.passed, false);
    assert.ok(
      result.differences.some((item) => item.includes("service worker")),
    );
    assert.equal(await ownedTabsClosed(), 1);
    assert.equal(await userPage.title(), "Portal");
  },
);

test(
  "parity-suite drivers attach only to owned tabs, fulfil or block writes, capture page traffic and exclude the toolkit panel",
  { timeout: 120_000 },
  async (t) => {
    const { openCdpTabDriver, openOwnedBrowser, captureProblem, clientObjectFacts } = await import("../parity-suite.mjs");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paqvilo-mirage-parity-suite-"));
    const received = [];
    const page = `<!doctype html><html lang="en"><head><title>Portal</title></head><body>
<div id="paqvilo-panel">toolkit panel</div>
<main id="content"><h1>Portal workspace</h1><ul id="rows"></ul><a id="leave" href="https://login.example.invalid/authorize">Sign in</a></main>
<script>
fetch("/_api/contacts(00000000-0000-0000-0000-000000000001)", { method: "PATCH", body: "{}" }).catch(() => {});
fetch("/save", { method: "POST", body: "x" }).catch(() => {});
fetch("/_api/items?$select=name").then((r) => r.json()).then((j) => { for (const item of j.value) { const li = document.createElement("li"); li.textContent = item.name; document.getElementById("rows").append(li); } });
</script></body></html>`;
    const server = http.createServer((req, res) => {
      received.push(`${req.method} ${req.url.split("?")[0]}`);
      if (req.url.startsWith("/_api/items")) {
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ "@odata.context": "x", value: [{ name: "One" }, { name: "Two" }] }));
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(500).end("write reached the server");
        return;
      }
      if (req.url.startsWith("/portal-user")) {
        // The platform client object names the contact only for a request carrying the session.
        const contact = /(?:^|; )session=signed(?:;|$)/.test(req.headers.cookie ?? "") ? "00000000-0000-0000-0000-00000000c0de" : "";
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(`<!doctype html><html><head><title>Portal</title><script>window.Microsoft = { Dynamic365: { Portal: { User: { contactId: "${contact}" } } } };</script></head><body><main>Workspace</main></body></html>`);
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      // The pre-existing user tab is a plain page; only driver tabs load the scripted page.
      res.end(req.url === "/user-page" ? "<!doctype html><title>User</title><p>User tab</p>" : page);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    let context;
    let owned;
    t.after(async () => {
      await owned?.close();
      await context?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    });
    const profile = path.join(directory, "profile");
    context = await chromium.launchPersistentContext(profile, browserLaunchOptions({
      headless: true,
      args: ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"],
    }));
    const userPage = context.pages()[0];
    await userPage.goto(`${origin}/user-page`);
    const port = (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n")[0];
    const fulfil = [{ method: "PATCH", pathPattern: "^/_api/contacts\\(", status: 204, reason: "answered locally in the regression fixture" }];
    const live = await openCdpTabDriver({ cdpUrl: `http://127.0.0.1:${port}`, origin, fulfil, allowLoopbackReference: true, timeout: 15_000 });
    const observation = await live.page("/", { roots: ["body"], settleMs: 200, quietMs: 300, settleTimeout: 8000, facts: ["#rows li", "#paqvilo-panel"] });
    const text = JSON.stringify(observation.snapshot);
    assert.equal(observation.status, 200);
    assert.ok(!text.includes("toolkit panel"), "the toolkit panel host is excluded");
    assert.ok(text.includes("Two"), "page-rendered rows are captured after settling");
    assert.deepEqual(observation.fulfilledWrites.map((item) => `${item.method} ${item.url} ${item.status}`), ["PATCH /_api/contacts({guid}) 204"]);
    assert.deepEqual(observation.blockedWrites.map((item) => item.method), ["POST"]);
    const api = observation.network.find((item) => item.url.startsWith("/_api/items"));
    assert.equal(api.projection.count, 2);
    assert.deepEqual(api.projection.fields, { name: ["string"] });
    assert.equal(observation.facts["#rows li"].total, 2);
    const source = await live.source("/", { settleMs: 0, quietMs: 200, settleTimeout: 5000 });
    assert.match(source.body, /<div id="paqvilo-panel">/);
    await live.close();
    for (let attempt = 0; attempt < 50 && context.pages().length > 1; attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(context.pages().length, 1, "only the driver's own tabs were opened and closed");
    assert.equal(new URL(userPage.url()).pathname, "/user-page");
    // Anonymous captures use an isolated context of the same browser: no cookies from the default
    // (signed-in) context, and the context and its tabs are gone after the driver closes.
    await context.addCookies([{ name: "session", value: "signed", url: origin }]);
    const anonymous = await openCdpTabDriver({ cdpUrl: `http://127.0.0.1:${port}`, origin, fulfil, isolated: true, allowLoopbackReference: true, timeout: 15_000 });
    assert.equal(anonymous.identity, "anonymous");
    const isolatedView = await anonymous.page("/", { roots: ["head"], settleMs: 100, quietMs: 300, settleTimeout: 8000, probeExpression: "document.cookie" });
    assert.equal(isolatedView.status, 200);
    assert.equal(isolatedView.probeValue, "", "the isolated context carries no cookies");
    // Playwright adopts the pages of a context created over CDP into its persistent context, so an
    // overlay route there (as in the toolkit) fetches the isolated page with the persistent
    // context's cookies. The platform client object then names a contact and the capture is refused.
    const direct = await anonymous.page("/portal-user", { roots: ["main"], settleMs: 100, quietMs: 300, settleTimeout: 8000 });
    assert.equal(direct.snapshot.signInSignals.portalUser, false);
    assert.equal(captureProblem("anonymous", direct), null);
    await context.route("**/portal-user-overlaid", async (route) => {
      const response = await context.request.fetch(route.request().url());
      await route.fulfill({ response });
    });
    const overlaid = await anonymous.page("/portal-user-overlaid", { roots: ["main"], settleMs: 100, quietMs: 300, settleTimeout: 8000 });
    await context.unroute("**/portal-user-overlaid");
    assert.equal(overlaid.snapshot.signInSignals.portalUser, true, "the adopted page was fetched with the persistent context's session");
    assert.match(captureProblem("anonymous", overlaid), /signed-in portal user/);
    const objects = await anonymous.page("/portal-user-overlaid", { roots: ["main"], settleMs: 100, quietMs: 300, settleTimeout: 8000, probeExpression: `(${clientObjectFacts.toString()})()` });
    const facts = JSON.parse(objects.probeValue);
    assert.deepEqual(facts.portal, [{ key: "User", type: "object" }]);
    assert.deepEqual(facts.user, [{ key: "contactId", type: "string", empty: true }], "names, types and empty flags only");
    assert.equal(facts.powerPages, null);
    await anonymous.close();
    let pageTargets = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      pageTargets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((target) => target.type === "page");
      if (pageTargets.length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(pageTargets.map((target) => new URL(target.url).pathname), ["/user-page"], "the isolated context's tabs are closed");
    owned = await openOwnedBrowser({ fulfil });
    const local = await owned.pageDriver(origin, "local").page("/", { roots: ["#content"], settleMs: 100, quietMs: 300, settleTimeout: 8000, probeExpression: "document.cookie" });
    assert.equal(local.probeValue, "", "an anonymous local capture sends no session cookie");
    assert.equal(local.snapshot.roots[0].count, 1);
    assert.deepEqual(local.fulfilledWrites.map((item) => item.method), ["PATCH"]);
    assert.deepEqual(local.blockedWrites.map((item) => item.method), ["POST"]);
    // Script guard: writes are stopped inside the page, reads (including XHR) are not intercepted.
    const guarded = await owned.pageDriver(origin, "local", { guard: "script", cookie: () => ({ name: "paqvilo-mirage-auth-1", value: "session" }) }).page("/", { roots: ["#content"], settleMs: 100, quietMs: 300, settleTimeout: 8000, probeExpression: "document.cookie" });
    assert.equal(guarded.probeValue, "paqvilo-mirage-auth-1=session", "a signed-in local capture carries the session cookie");
    assert.match(JSON.stringify(guarded.snapshot), /Two/);
    assert.deepEqual(guarded.fulfilledWrites.map((item) => `${item.method} ${item.url} ${item.status}`), ["PATCH /_api/contacts({guid}) 204"]);
    assert.deepEqual(guarded.blockedWrites.map((item) => `${item.method} ${item.url}`), ["POST /save"]);
    assert.ok(!received.some((line) => !line.startsWith("GET")), `no write reached the fixture server: ${received.join(", ")}`);
  },
);
