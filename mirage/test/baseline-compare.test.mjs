// Baseline comparison and matrix regressions: invented requests, markup and folders only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseFragment } from "parse5";
import { compareRequests, diffDom, compareElements, compareConsole, compareScenario, loadAllowlist, summarize, summaryMarkdown, normalizeGeneratedIds } from "../baseline-compare.mjs";
import { validateMatrix, scenarioDir, captureMatrix } from "../baseline-suite.mjs";

const req = (seq, url, extra = {}) => ({ seq, method: "GET", url, resourceType: "fetch", headers: { accept: "*/*" }, body: null, response: { status: 200, headers: { "content-type": "application/json" }, body: "{}" }, ...extra });

test("request alignment reports presence deltas in order", () => {
  const live = [req(1, "https://p.invalid/a"), req(2, "https://p.invalid/b"), req(3, "https://p.invalid/c")];
  const mirage = [req(1, "https://p.invalid/a"), req(2, "https://p.invalid/c"), req(3, "https://p.invalid/d")];
  const out = compareRequests(live, mirage);
  assert.deepEqual(out.map((d) => [d.field, d.location, d.live, d.mirage]), [
    ["presence", "#2 GET https://p.invalid/b", "present", "(absent)"],
    ["presence", "#3 GET https://p.invalid/d", "(absent)", "present"],
  ]);
});

test("paired requests report query, header, body and status differences; bodies are canonicalised", () => {
  const json = { "content-type": "application/json" };
  const form = { "content-type": "application/x-www-form-urlencoded" };
  const live = [
    req(1, "https://p.invalid/q?x=1", { headers: { accept: "a" } }),
    req(2, "https://p.invalid/j", { method: "POST", headers: json, body: '{"a":1,"b":[1,2]}', response: { status: 200, headers: json, body: '{"v":1,"w":2}' } }),
    req(3, "https://p.invalid/f", { method: "POST", headers: form, body: "b=2&a=1", response: { status: 204, headers: {}, body: null } }),
    req(4, "https://p.invalid/g", { method: "POST", headers: form, body: "a=1" }),
  ];
  const mirage = [
    req(1, "https://p.invalid/q?x=2", { headers: { accept: "b" } }),
    req(2, "https://p.invalid/j", { method: "POST", headers: json, body: '{"b":[1,2],"a":1}', response: { status: 200, headers: json, body: '{"w":2,"v":3}' } }),
    req(3, "https://p.invalid/f", { method: "POST", headers: form, body: "a=1&b=2", response: { status: 204, headers: {}, body: null } }),
    req(4, "https://p.invalid/g", { method: "POST", headers: form, body: "a=2", response: { status: 500, headers: json, body: "{}" } }),
  ];
  const fields = compareRequests(live, mirage).map((d) => `${d.scope}:${d.location.split(" ")[0]}:${d.field}`);
  assert.deepEqual(fields.sort(), ["request:#1/1:headers.accept", "request:#1/1:query", "request:#4/4:body.a[0]", "response:#2/2:body.v", "response:#4/4:status"].sort());
});

test("DOM diff reports tag, attribute, class, text and children deltas and ignores nonce", () => {
  const a = parseFragment('<div id="r" class="x  y" nonce="1" title="t"><p>Hi</p><span>s</span></div>');
  const b = parseFragment('<div id="r" class="y x" nonce="2" title="u"><p>Bye</p><b>s</b><i></i></div>');
  const out = diffDom(a, b, []);
  assert.deepEqual(out.map((d) => d.field).sort(), ["attr.title", "children.length", "class", "tag", "text"]);
  assert.ok(!out.some((d) => d.field.includes("nonce")));
  assert.equal(diffDom(parseFragment('<p nonce="a">x</p>'), parseFragment('<p nonce="b">x</p>'), []).length, 0);
});

test("element and console diffs", () => {
  const el = (selector, extra = {}) => ({ selector, tag: "input", classes: ["c"], attributes: { name: "n" }, visible: true, disabled: false, readonly: false, required: false, value: "", ...extra });
  const out = compareElements([el("#a"), el("#b"), el("#gone")], [el("#a", { disabled: true, classes: ["d"] }), el("#b", { attributes: { name: "m" } }), el("#new")]);
  assert.deepEqual(out.map((d) => `${d.location}:${d.field}`).sort(), ["#a:classes", "#a:disabled", "#b:attributes.name", "#gone:presence", "#new:presence"]);
  const cons = compareConsole({ console: [{ type: "error", text: "boom" }, { type: "log", text: "ignored" }], pageErrors: ["e1"] }, { console: [{ type: "warning", text: "w" }], pageErrors: [] });
  assert.deepEqual(cons.map((d) => `${d.location}|${d.live}|${d.mirage}`), ["console|error: boom|(absent)", "console|(absent)|warning: w", "pageErrors|e1|(absent)"]);
});

async function writeFolder(dir, { status = "captured", dom = "<html><head></head><body><h1>Hello</h1></body></html>" } = {}) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ status, problems: status === "captured" ? [] : ["x"], title: "T", finalUrl: "https://p.invalid/" }));
  await fs.writeFile(path.join(dir, "requests.json"), "[]");
  await fs.writeFile(path.join(dir, "elements.json"), "[]");
  await fs.writeFile(path.join(dir, "console.json"), JSON.stringify({ console: [], pageErrors: [] }));
  await fs.writeFile(path.join(dir, "dom.html"), dom);
}

test("grid data Attributes arrays are compared by name, other arrays by position", () => {
  const body = (attrs, columns) => JSON.stringify({ Records: [{ Attributes: attrs }], Columns: columns });
  const request = (postData) => [{ seq: 1, method: "POST", url: "https://a.test/_services/entity-grid-data.json/x", resourceType: "xhr", headers: { "content-type": "application/json" }, body: postData, response: { status: 200, headers: {}, body: null } }];
  const same = compareRequests(request(body([{ Name: "b", Value: 2 }, { Name: "a", Value: 1 }], ["x", "y"])), request(body([{ Name: "a", Value: 1 }, { Name: "b", Value: 2 }], ["x", "y"])));
  assert.deepEqual(same.filter((d) => d.field.startsWith("body")), []);
  const valueChanged = compareRequests(request(body([{ Name: "a", Value: 1 }], ["x"])), request(body([{ Name: "a", Value: 9 }], ["x"])));
  assert.deepEqual(valueChanged.filter((d) => d.field.startsWith("body")).map((d) => d.field), ["body.Records[0].Attributes.a.Value"]);
  const columnsReordered = compareRequests(request(body([], ["x", "y"])), request(body([], ["y", "x"])));
  assert.equal(columnsReordered.filter((d) => d.field.startsWith("body")).length, 2);
});

test("compareScenario verdicts, allowlist classification, second-live variance and summaries", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paqvilo-baseline-compare-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scenario = { id: "area/page" };
  const dir = (name) => path.join(root, name);
  const changed = "<html><head></head><body><h1>Changed</h1></body></html>";
  await writeFolder(dir("live"));
  await writeFolder(dir("same"));
  await writeFolder(dir("changed"), { dom: changed });
  await writeFolder(dir("live-2"), { dom: changed });
  await writeFolder(dir("broken"), { status: "failed" });
  const allowFile = dir("allow.json");
  await fs.writeFile(allowFile, JSON.stringify({ version: 1, entries: [{ id: "heading", scope: "dom", pattern: "h1", field: "^text$", reason: "invented", proof: "live-run-variance", evidence: "fixture" }] }));
  const allowlist = await loadAllowlist(allowFile);
  const none = { entries: [] };

  const pass = await compareScenario({ scenario, liveDir: dir("live"), mirageDir: dir("same"), allowlist: none });
  assert.equal(pass.verdict, "PASS");
  const fail = await compareScenario({ scenario, liveDir: dir("live"), mirageDir: dir("changed"), allowlist: none });
  assert.equal(fail.verdict, "FAIL");
  assert.deepEqual(fail.deltas.map((d) => [d.scope, d.field, d.live, d.mirage]), [["dom", "text", "Hello", "Changed"]]);
  assert.equal(fail.signatures.length, 1);
  const allowedResult = await compareScenario({ scenario, liveDir: dir("live"), mirageDir: dir("changed"), allowlist });
  assert.equal(allowedResult.verdict, "ALLOWED");
  assert.equal(allowedResult.deltas[0].allowlist, "heading");
  // A value pattern narrows an entry to the values it names: "Changed" is allowed, another text is not.
  const valueFile = dir("allow-value.json");
  const valueEntry = { id: "heading-value", scope: "dom", pattern: "h1", field: "^text$", value: "^Chang", reason: "invented", proof: "live-run-variance", evidence: "fixture" };
  await fs.writeFile(valueFile, JSON.stringify({ version: 1, entries: [valueEntry] }));
  const valued = await loadAllowlist(valueFile);
  assert.equal((await compareScenario({ scenario, liveDir: dir("live"), mirageDir: dir("changed"), allowlist: valued })).verdict, "ALLOWED");
  await writeFolder(dir("other"), { dom: changed.replace("Changed", "Other") });
  assert.equal((await compareScenario({ scenario, liveDir: dir("live"), mirageDir: dir("other"), allowlist: valued })).verdict, "FAIL");
  await fs.writeFile(valueFile, JSON.stringify({ version: 1, entries: [{ ...valueEntry, value: "" }] }));
  await assert.rejects(loadAllowlist(valueFile), /empty value pattern/);
  // With a second live capture, a live-run-variance entry explains only deltas that capture varied on.
  await writeFolder(dir("live-same"));
  const unproven = await compareScenario({ scenario, liveDir: dir("live"), mirageDir: dir("changed"), secondDir: dir("live-same"), allowlist });
  assert.equal(unproven.verdict, "FAIL");
  assert.equal(unproven.deltas[0].unprovenVariance, "heading");
  const proven = await compareScenario({ scenario, liveDir: dir("live"), mirageDir: dir("changed"), secondDir: dir("live-2"), allowlist });
  assert.equal(proven.verdict, "ALLOWED");
  const variance = await compareScenario({ scenario, liveDir: dir("live"), mirageDir: dir("changed"), secondDir: dir("live-2"), allowlist: none });
  assert.equal(variance.deltas[0].liveVariance, true);
  assert.equal(variance.variance.folder, "live-2");
  assert.equal(fail.deltas[0].liveVariance, undefined);
  const missing = await compareScenario({ scenario, liveDir: dir("live"), mirageDir: dir("nope"), allowlist: none });
  assert.equal(missing.verdict, "error");
  assert.match(missing.reason, /mirage capture missing/);
  const unusable = await compareScenario({ scenario, liveDir: dir("live"), mirageDir: dir("broken"), allowlist: none });
  assert.match(unusable.reason, /not usable/);

  const entry = { id: "x", scope: "dom", pattern: "a", field: "b", reason: "r", proof: "platform-generated", evidence: "e" };
  for (const bad of [{ version: 2, entries: [] }, { version: 1, entries: [{ ...entry, reason: "" }] }, { version: 1, entries: [{ ...entry, proof: "hunch" }] }, { version: 1, entries: [{ ...entry, scope: "page" }] }]) {
    await fs.writeFile(allowFile, JSON.stringify(bad));
    await assert.rejects(loadAllowlist(allowFile));
  }

  const report = { generatedAt: "2026-01-01", scenarios: [pass, fail, allowedResult, unusable].map((r, i) => ({ ...r, id: `s${i}` })) };
  Object.assign(report, summarize(report));
  assert.deepEqual(report.totals, { pass: 1, allowed: 1, fail: 1, error: 1 });
  assert.equal(report.bySignature[0].allowed, false);
  const md = summaryMarkdown(report);
  assert.match(md, /PASS 1 · ALLOWED 1 · FAIL 1 · ERROR 1/);
  assert.match(md, /\| s1 \| FAIL \| 1 \| 0 \| 1 \|/);
  assert.match(md, /\| dom \| text \|/);
});

test("validateMatrix accepts a good matrix and rejects invalid ones", () => {
  const good = () => ({ version: 1, origin: "https://portal.invalid", personas: { member: {} }, writeScope: { paths: ["^/x$"] }, scenarios: [{ id: "a/b", persona: "member", steps: [{ goto: "/" }] }, { id: "c", steps: [{ goto: "/c" }] }] });
  assert.equal(validateMatrix(good()).scenarios.length, 2);
  const mutate = (fn) => {
    const matrix = good();
    fn(matrix);
    return matrix;
  };
  assert.throws(() => validateMatrix(mutate((m) => (m.scenarios[1].id = "a/b"))), /Duplicate/);
  assert.throws(() => validateMatrix(mutate((m) => (m.scenarios[0].persona = "ghost"))), /unknown persona/);
  assert.throws(() => validateMatrix(mutate((m) => (m.scenarios[0].steps = []))), /needs steps/);
  assert.throws(() => validateMatrix(mutate((m) => delete m.scenarios[1].steps)), /needs steps/);
  assert.throws(() => validateMatrix(mutate((m) => (m.origin = "http://portal.invalid"))), /HTTPS/);
  assert.throws(() => validateMatrix(mutate((m) => (m.origin = "https://portal.invalid/path"))), /HTTPS/);
  assert.throws(() => validateMatrix({ version: 1, scenarios: [] }));
  assert.equal(scenarioDir("/out", { id: "a/b" }, "live"), path.join("/out", "a", "b", "live"));
});

test("captureMatrix switches personas only on change, honours reset:false and records side errors", async () => {
  const calls = [];
  const side = {
    persona: async (name) => calls.push(`persona:${name}`),
    reset: async () => calls.push("reset"),
    capture: async (scenario) => {
      calls.push(`capture:${scenario.id}`);
      if (scenario.id === "bad") throw new Error("bridge down");
      return { status: "captured", problems: [], requests: 2, elements: 3, blockedWrites: [{}] };
    },
    diagnostics: () => ["diag"],
    close: async () => {},
  };
  const matrix = { delayMs: 0, scenarios: [{ id: "one", steps: [{}] }, { id: "two", reset: false, steps: [{}] }, { id: "bad", persona: "m", steps: [{}] }, { id: "skip", steps: [{}] }] };
  const log = console.log;
  console.log = () => {};
  let results;
  try {
    results = await captureMatrix({ matrix, side, outDir: "/out", label: "mirage", only: ["one", "two", "bad"] });
  } finally {
    console.log = log;
  }
  assert.deepEqual(calls, ["persona:anonymous", "reset", "capture:one", "capture:two", "persona:m", "reset", "capture:bad"]);
  assert.deepEqual(results.map((r) => r.status), ["captured", "captured", "error"]);
  assert.equal(results[0].blockedWrites, 1);
  assert.deepEqual(results[2].problems, ["bridge down", "diag"]);
});

test("request-side x-sim-* headers are instrumentation and generated ids are normalised", () => {
  const req = (headers) => ({ seq: 1, method: "GET", url: "/a", resourceType: "fetch", headers, response: { status: 200, headers: {} } });
  const out = compareRequests([req({ accept: "*/*" })], [req({ accept: "*/*", "x-sim-parent-trace": "t" })]);
  assert.equal(out.length, 0);
  assert.equal(normalizeGeneratedIds('<div id="PcfControl_4eb7269f8c084cd683f6361ce8864541"><div id="UpdMSPicklistControl7_outer">'), '<div id="PcfControl_{hex32}"><div id="UpdMSPicklistControl{n}_outer">');
});
