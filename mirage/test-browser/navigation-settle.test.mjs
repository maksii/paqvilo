import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { awaitWritesBeforeDocument, DOCUMENT_REQUEST_PATTERN } from "../lib/navigation-settle.mjs";

// Synthetic loopback server: page /a starts a slow script write (PATCH /write) and a slow
// read (GET /read) on load and links to /b; it can also issue a synchronous request that is
// answered with a redirect. The server records whether each response finished or the client
// closed it first.
async function fixture(t, { writeDelay = 400, pause = true, timeout = 10000 } = {}) {
  const outcomes = [];
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push(url.pathname);
    if (url.pathname === "/a")
      return res.end(
        "<!doctype html><title>A</title><a id='next' href='/b'>next</a><script>" +
          "fetch('/write', { method: 'PATCH', body: '{}' }).then(() => sessionStorage.setItem('saved', '1'));" +
          "fetch('/read');" +
          "document.getElementById('next').addEventListener('click', () => setTimeout(() => { var x = new XMLHttpRequest(); x.open('GET', '/redirect', false); x.send(); window.synchronous = x.status; }, 20));" +
          "</script>",
      );
    if (url.pathname === "/b") return setTimeout(() => res.end("<!doctype html><title>B</title>"), 200);
    if (url.pathname === "/redirect") return setTimeout(() => res.writeHead(301, { location: "/target" }).end(), 500);
    if (url.pathname === "/target") return res.end("ok");
    const delay = url.pathname === "/write" ? writeDelay : 400;
    res.on("close", () => outcomes.push({ path: url.pathname, finished: res.writableFinished }));
    setTimeout(() => {
      if (!res.destroyed) {
        res.statusCode = url.pathname === "/write" ? 204 : 200;
        res.end();
      }
    }, delay);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    // A preconnected socket that never sent a request would hold server.close open.
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage();
  // The runner's bookkeeping: CDP Network records and paused document requests.
  const cdp = await page.context().newCDPSession(page);
  const records = new Map();
  const parents = new Map();
  for (const name of ["Page.frameAttached", "Page.frameNavigated"])
    cdp.on(name, (event) => {
      const frameId = event.frameId ?? event.frame?.id;
      const parentId = event.parentFrameId ?? event.frame?.parentId;
      if (frameId && parentId) parents.set(frameId, parentId);
    });
  cdp.on("Network.requestWillBeSent", (event) =>
    records.set(event.requestId, { frameId: event.frameId, method: event.request.method, type: event.type, path: new URL(event.request.url).pathname }),
  );
  cdp.on("Network.loadingFinished", (event) => records.get(event.requestId) && (records.get(event.requestId).finishedTimestamp = event.timestamp));
  cdp.on("Network.loadingFailed", (event) => records.get(event.requestId) && (records.get(event.requestId).failure = event.errorText));
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");
  const waits = [];
  if (pause) {
    cdp.on("Fetch.requestPaused", (event) => {
      awaitWritesBeforeDocument(event.frameId, () => [...records.values()], () => parents, { timeout })
        .then((wait) => wait && waits.push(wait))
        .finally(() => cdp.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => {}));
    });
    await cdp.send("Fetch.enable", { patterns: [DOCUMENT_REQUEST_PATTERN] });
  }
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { page, outcomes, requests, waits, origin };
}

test("a navigation waits until the replaced document's in-flight script write settles", async (t) => {
  const { page, outcomes, waits, origin } = await fixture(t, { writeDelay: 1200 });
  const write = page.waitForRequest((request) => request.url().endsWith("/write"));
  await page.goto(origin + "/a");
  await write;
  await page.evaluate(() => {
    // Remove the synchronous request this test does not exercise.
    const link = document.getElementById("next");
    link.replaceWith(link.cloneNode(true));
  });
  await page.click("#next");
  await page.waitForURL(origin + "/b");
  // The write completed in the old document before it was replaced; reads do not hold navigation.
  assert.equal(waits.length, 1);
  assert.deepEqual(waits[0].writes, ["PATCH /write"]);
  assert.equal(waits[0].settled, true);
  assert.ok(waits[0].waitedMs >= 500, `waited ${waits[0].waitedMs} ms`);
  assert.deepEqual(outcomes.find((row) => row.path === "/write"), { path: "/write", finished: true });
  assert.equal(await page.evaluate(() => sessionStorage.getItem("saved")), "1");
});

test("without the pause the browser abandons the write; the wait itself is bounded", async (t) => {
  const plain = await fixture(t, { writeDelay: 1500, pause: false });
  const write = plain.page.waitForRequest((request) => request.url().endsWith("/write"));
  await plain.page.goto(plain.origin + "/a");
  await write;
  await plain.page.evaluate(() => {
    const link = document.getElementById("next");
    link.replaceWith(link.cloneNode(true));
  });
  await plain.page.click("#next");
  await plain.page.waitForURL(plain.origin + "/b");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(plain.outcomes.find((row) => row.path === "/write"), { path: "/write", finished: false });

  const bounded = await fixture(t, { writeDelay: 5000, timeout: 300 });
  const slow = bounded.page.waitForRequest((request) => request.url().endsWith("/write"));
  await bounded.page.goto(bounded.origin + "/a");
  await slow;
  await bounded.page.evaluate(() => {
    const link = document.getElementById("next");
    link.replaceWith(link.cloneNode(true));
  });
  await bounded.page.click("#next");
  await bounded.page.waitForURL(bounded.origin + "/b");
  assert.equal(bounded.waits.length, 1);
  assert.equal(bounded.waits[0].settled, false);
  assert.ok(bounded.waits[0].waitedMs >= 300 && bounded.waits[0].waitedMs < 5000, `waited ${bounded.waits[0].waitedMs} ms`);
});

test("pausing only documents lets a redirected synchronous request finish while its frame navigates", async (t) => {
  const { page, requests, origin } = await fixture(t, { writeDelay: 50 });
  await page.goto(origin + "/a");
  await page.waitForLoadState("networkidle");
  // The click starts the navigation; the page then sends a synchronous request answered with a redirect.
  await page.click("#next");
  await page.waitForURL(origin + "/b", { timeout: 10000 });
  assert.ok(requests.includes("/target"), `requests: ${requests.join(", ")}`);
});
