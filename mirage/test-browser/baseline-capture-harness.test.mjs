// Baseline capture: `harness: true` steps leave no evidence (synthetic loopback site, owned headless browser).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { pageRunner } from "../baseline-capture.mjs";

test("harness steps run but their requests, console entries and final URL are not recorded", { timeout: 120_000 }, async (t) => {
  let cleared = 0;
  const server = http.createServer((req, res) => {
    const page = (body) => res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><head><link rel="icon" href="data:,"></head><body>${body}</body></html>`);
    if (req.url === "/about" && req.method === "POST") return (cleared++, page("<p>cleared</p>"));
    if (req.url === "/about") return page('<script>console.log("harness log")</script><form method="post" action="/about"><input type="submit" name="clearCache" value="Clear"></form>');
    if (req.url === "/item") return page("<h1 id='item'>Item</h1>");
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await (await browser.newContext()).newPage();
  const run = (steps) => pageRunner(page, { origin, scenario: { id: "harness", steps, expect: { present: ["#item"] } }, allowWrites: true, allowPaths: ["^/about$"], settle: { quietMs: 200 } });

  const result = await run([{ goto: "/item" }, { goto: "/about", harness: true }, { click: "input[name='clearCache']", harness: true }, { wait: 300, harness: true }, { goto: "/item" }]);
  assert.equal(cleared, 1, "the harness step still runs");
  assert.deepEqual(result.raw.requests.filter((r) => r.resourceType === "document").map((r) => [r.method, new URL(r.url).pathname, r.seq]), [["GET", "/item", 1], ["GET", "/item", 2]]);
  assert.equal(result.raw.console.some((entry) => entry.text === "harness log"), false);
  assert.equal(result.summary.status, "captured", result.summary.problems.join("; "));

  const failing = await run([{ goto: "/item" }, { click: "#missing", harness: true, timeout: 500 }]);
  assert.notEqual(failing.summary.status, "captured", "a harness step's error is still reported");
});
