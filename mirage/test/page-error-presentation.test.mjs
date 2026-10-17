import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "parse5";
import { observedPageErrorResponse } from "../lib/page-error-presentation.mjs";
import { observedConfig } from "../lib/project-config.mjs";
import { createSimulator } from "../server.mjs";

const observed = { pageErrorPresentation: "generic-error", evidence: "invented-loopback/error-structure.json" };
const failure = { status: 500, code: "PAGE_QUERY_REQUEST_VALIDATION", message: "invented diagnostic detail" };
const options = { method: "GET", error: failure, observed };
function elements(document, tag) {
  const found = [];
  function visit(node) {
    if (node.tagName === tag) found.push(node);
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(document);
  return found;
}
const text = node => (node.childNodes ?? []).map(child => child.value ?? text(child)).join("");

test("the evidenced error structure uses a fresh local UUID and finite visible content", () => {
  const first = observedPageErrorResponse(options), second = observedPageErrorResponse(options);
  assert.equal(first.status, 500);
  assert.equal(first.headers["content-type"], "text/html; charset=utf-8");
  const document = parse(first.body), headings = elements(document, "h1");
  assert.equal(text(elements(document, "title")[0]), "We're sorry, but something went wrong (500)");
  assert.equal(text(headings[0]), "We're sorry, but something went wrong. Please try again, and if this persists, contact the website administrator.");
  assert.match(text(headings[1]), /^Error ID: \[[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\]$/);
  assert.notEqual(first.body, second.body);
  const boundary = elements(document, "div")[0];
  assert.equal(text(boundary), "A potentially dangerous Request.QueryString value was detected from the client");
  assert.deepEqual(boundary.attrs, []);
  assert.equal(elements(document, "script").length, 0);
  assert.equal(first.body.includes(failure.message), false);
});

test("unobserved methods, exception classes, statuses and the default retain diagnostics", () => {
  for (const method of ["HEAD", "POST", "PATCH", "DELETE", "OPTIONS"])
    assert.equal(observedPageErrorResponse({ ...options, method }), null);
  for (const error of [{ ...failure, status: 400 }, { ...failure, code: "OTHER_ERROR" }, {}, null])
    assert.equal(observedPageErrorResponse({ ...options, error }), null);
  for (const observed of [undefined, {}, { pageErrorPresentation: "diagnostic" }])
    assert.equal(observedPageErrorResponse({ ...options, observed }), null);
  assert.equal(observedPageErrorResponse({ ...options, error: { statusCode: 500, code: failure.code } }).status, 500);
});

test("the presentation mode requires site evidence and a known choice", () => {
  assert.equal(observedConfig(observed).pageErrorPresentation, "generic-error");
  assert.throws(() => observedConfig({ pageErrorPresentation: "generic-error" }), /evidence/);
  assert.throws(() => observedConfig({ ...observed, pageErrorPresentation: "all-errors" }), /pageErrorPresentation/);
});

test("loopback HTTP preserves the selected status, media type and structure without input probes", async t => {
  // A fabricated fixed exception tests presentation only. No query scanner,
  // injection payload, native browser or external request is involved.
  const server = http.createServer((request, response) => {
    const answer = observedPageErrorResponse({ ...options, method: request.method });
    response.writeHead(answer?.status ?? 400, answer?.headers ?? { "content-type": "text/plain" });
    response.end(answer?.body ?? "ordinary diagnostic");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const response = await fetch(url);
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(elements(parse(await response.text()), "h1").length, 2);
  const post = await fetch(url, { method: "POST" });
  assert.equal(post.status, 400);
  assert.equal(await post.text(), "ordinary diagnostic");
});

test("Mirage leaves ordinary pages and unrelated route errors unchanged in the selected mode", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mirage-page-presentation-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const files = {
    "website.yml": "adx_websiteid: invented-error-site\nadx_name: Invented error site",
    "web-pages/Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main",
    "page-templates/Main.pagetemplate.yml": "adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false",
    "web-templates/Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
    "web-templates/Main.webtemplate.source.html": "<p>Ordinary page</p>",
  };
  for (const [name, source] of Object.entries(files)) {
    const destination = path.join(directory, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, source);
  }
  const app = await createSimulator({ sourceDir: directory, stateFile: path.join(directory, "state.json"), port: 0, watch: false,
    observed: { ...observed, siteMarkerRedirect: "null-reference" } });
  t.after(() => app.close());
  const page = await fetch(app.url + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Ordinary page/);
  app.portal.redirects.push({ inboundUrl: "missing-marker", siteMarkerId: "invented-absent-marker" });
  const response = await fetch(app.url + "/missing-marker", { redirect: "manual" });
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.match(body, /Portal simulation diagnostic/);
  assert.match(body, /Object reference not set to an instance of an object/);
  assert.equal(body.includes("Error ID:"), false);
});
