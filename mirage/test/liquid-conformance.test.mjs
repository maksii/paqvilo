// golden-liquid conformance tool: case rendering, rule classification, stale rules and the
// generated tables (synthetic suite; the pinned suite itself is not vendored).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_RULES, classify, conformance, markdown, runCase } from "../liquid-conformance.mjs";

const SUITE = {
  description: "synthetic",
  tests: [
    { name: "passes", template: "{{ a | upcase }}", data: { a: "x" }, result: "X", tags: ["upcase filter"] },
    { name: "expects an error", template: "{% if %}", invalid: true, tags: ["if tag"] },
    { name: "hash data", template: "{{ h | size }}|{{ h.k }}|{{ h | map: 'k' | size }}", data: { h: { k: "v", l: 1 } }, result: "2|v|2" },
    { name: "unsupported", template: "{% echo 'x' %}", result: "x", tags: ["echo tag"] },
    { name: "divergence", template: "{{ 'BzAa4' | sort | join: '#' }}", result: "BzAa4", tags: ["sort filter"] },
    { name: "unexplained", template: "{{ 'a' | append: 'b' }}", result: "x", tags: [] },
  ],
};
const RULES = {
  suite: { repository: "https://example.invalid/golden-liquid", commit: "0000000" },
  reasons: { order: "Characters compare ordinally." },
  rules: [
    { match: { tag: "echo tag" }, category: "platform-unsupported", reason: "No echo tag." },
    { match: { name: "divergence" }, category: "dotliquid-divergence", reason: "order", dotliquid: { master: "4#A#B#a#z", "2.0.385": "4#A#B#a#z", "2.0.64": "4#A#B#a#z" } },
    { match: { name: "passes" }, category: "engine-gap", reason: "Stale: the case passes." },
  ],
};

test("cases render with hash data and an expected error passes when one is raised", async () => {
  assert.deepEqual(await runCase(SUITE.tests[0]), { pass: true, output: "X", raised: false, error: null });
  const invalid = await runCase(SUITE.tests[1]);
  assert.equal(invalid.pass, true);
  assert.equal(invalid.raised, true);
  // JSON objects become Liquid hashes, as DotLiquid's Hash.FromDictionary does.
  assert.equal((await runCase(SUITE.tests[2])).output, "2|v|2");
  assert.equal(classify(SUITE.tests[3], RULES.rules).category, "platform-unsupported");
  assert.equal(classify(SUITE.tests[5], RULES.rules), null);
});

test("conformance classifies differing cases, reports unexplained ones as engine gaps and lists stale rules", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "liquid-conformance-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "suite.json"), JSON.stringify(SUITE));
  await fs.writeFile(path.join(dir, "rules.json"), JSON.stringify(RULES));
  const report = await conformance({ suite: path.join(dir, "suite.json"), rules: path.join(dir, "rules.json") });
  assert.deepEqual(report.counts, { total: 6, expectError: 1, pass: 3, differ: 3, "platform-unsupported": 1, "dotliquid-divergence": 1, "engine-gap": 1 });
  assert.deepEqual(report.staleRules, ["passes"]);
  const byName = Object.fromEntries(report.differences.map((difference) => [difference.name, difference]));
  assert.equal(byName.divergence.reason, "Characters compare ordinally.");
  assert.equal(byName.divergence.reasonKey, "order");
  assert.deepEqual(byName.divergence.mirage, { output: "4#A#B#a#z" });
  assert.equal(byName.unexplained.category, "engine-gap");
  assert.equal(byName.unexplained.reason, "No rule explains this difference.");
  const text = markdown(report);
  assert.match(text, /^Cases: 6 \(1 expect an error\)\. Pass: 3\. Differ: 3/);
  assert.match(text, /\| echo tag \| 1 \| No echo tag\. \| unsupported \|/);
  assert.match(text, /\| `order` \| 1 \| Characters compare ordinally\. \|/);
  assert.match(text, /\| divergence \| "BzAa4" \| "4#A#B#a#z" \| "4#A#B#a#z" \(all\) \| `order` \|/);
  assert.match(text, /\| unexplained \| "x" \| "ab" \|  \| No rule explains this difference\. \|/);
  assert.match(text, /Stale rules \(their cases now pass\): passes\./);
});

test("the shipped rules file is valid and every rule names a known category and reason", async () => {
  const rules = JSON.parse(await fs.readFile(DEFAULT_RULES, "utf8"));
  assert.match(rules.suite.commit, /^[0-9a-f]{40}$/);
  const categories = new Set(["platform-unsupported", "dotliquid-divergence", "engine-gap"]);
  for (const rule of rules.rules) {
    assert.ok(categories.has(rule.category), rule.category);
    assert.ok(rule.match.name !== undefined || rule.match.tag !== undefined);
    if (rule.match.name !== undefined) assert.ok(Object.hasOwn(rules.reasons, rule.reason), rule.reason);
  }
  const names = rules.rules.filter((rule) => rule.match.name !== undefined).map((rule) => rule.match.name);
  assert.equal(new Set(names).size, names.length);
});
