#!/usr/bin/env node
/**
 * golden-liquid conformance report for the Mirage Liquid engine.
 *
 *   node mirage/liquid-conformance.mjs --suite <golden_liquid.json> [--rules FILE]
 *        [--json | --markdown] [--out FILE] [--timeout MS]
 *
 * Runs every case of the MIT golden-liquid suite (github.com/jg-rp/golden-liquid, pinned in the
 * rules file; the suite is not vendored, see docs/liquid-conformance.md) through the Mirage
 * renderer with the case's data and partial templates. A case passes when the output equals the
 * suite's Shopify Liquid expectation (or an error is raised where the suite expects one). Every
 * other case is classified by the rules file (default lib/liquid-conformance-rules.json):
 *   - platform-unsupported: a tag, filter or syntax that DotLiquid and Power Pages do not provide;
 *   - dotliquid-divergence: the Mirage renders what DotLiquid (or the Adxstudio filter that
 *     Power Pages registers over the DotLiquid one) renders, which differs from Shopify Liquid;
 *   - engine-gap: the Mirage differs from DotLiquid. A differing case without a rule is
 *     reported as an engine gap too. Gaps are listed, never hidden.
 * Rules match a case by exact name or by suite tag; `reason` is a key of the rules file's
 * `reasons` (or literal text) and `dotliquid` records the reference outputs per DotLiquid build.
 * Name rules for cases that now pass are reported as stale. Read-only and non-gating: the exit
 * code is 0 unless the suite or the rules cannot be read.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPortalRenderer } from "./lib/liquid.mjs";
import { LiquidHash } from "./lib/liquid-engine.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RULES = path.join(HERE, "lib", "liquid-conformance-rules.json");
export const CATEGORIES = ["platform-unsupported", "dotliquid-divergence", "engine-gap"];
/** DotLiquid reference builds, most relevant first (the engine follows `master`). */
export const REFERENCES = ["master", "2.0.385", "2.0.64"];
const ERROR_CODES = new Set(["liquid-syntax-error", "liquid-error", "liquid-runtime-error"]);

const withTimeout = (promise, ms) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`render timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/** JSON objects of a case's data become Liquid hashes, as DotLiquid's Hash.FromDictionary does. */
const toLiquid = (value) =>
  Array.isArray(value)
    ? value.map(toLiquid)
    : value && typeof value === "object"
      ? new LiquidHash(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toLiquid(item)])))
      : value;

/** Render one golden-liquid case. `raised` is true when the render reported a Liquid error. */
export async function runCase(test, { timeoutMs = 5000 } = {}) {
  const templates = {};
  for (const [name, source] of Object.entries(test.templates ?? {})) templates[name] = { id: name, name, source };
  const renderer = createPortalRenderer({
    templates,
    snippets: {},
    settings: {},
    pages: [],
    webFiles: [],
    records: [],
    weblinks: {},
    sitemarkers: {},
    website: {},
    pageTemplates: [],
  });
  const diagnostics = [];
  let output = null;
  let thrown = null;
  try {
    const data = Object.fromEntries(Object.entries(test.data ?? {}).map(([key, value]) => [key, toLiquid(value)]));
    output = await withTimeout(renderer.renderString(test.template, { ...data, __diagnostics: diagnostics }), timeoutMs);
  } catch (error) {
    thrown = error;
  }
  const errors = diagnostics.filter((diagnostic) => ERROR_CODES.has(diagnostic.code));
  const raised = Boolean(thrown) || errors.length > 0;
  const pass = test.invalid ? raised : !raised && output === test.result;
  return { pass, output, raised, error: thrown ? String(thrown?.message ?? thrown) : (errors[0]?.message ?? null) };
}

/** The rule for a case: by exact name, else the first matching tag rule. */
export function classify(test, rules) {
  return (
    rules.find((rule) => rule.match?.name === test.name) ??
    rules.find((rule) => rule.match?.tag !== undefined && (test.tags ?? []).includes(rule.match.tag)) ??
    null
  );
}

export async function conformance({ suite, rules: rulesFile = DEFAULT_RULES, timeoutMs = 5000 }) {
  const document = JSON.parse(await fs.readFile(suite, "utf8"));
  const tests = Array.isArray(document.tests) ? document.tests : [];
  const rulesDocument = JSON.parse(await fs.readFile(rulesFile, "utf8"));
  const rules = rulesDocument.rules ?? [];
  const reasons = rulesDocument.reasons ?? {};
  const used = new Set();
  const counts = { total: tests.length, expectError: tests.filter((test) => test.invalid).length, pass: 0, differ: 0 };
  for (const category of CATEGORIES) counts[category] = 0;
  const differences = [];
  for (const test of tests) {
    const result = await runCase(test, { timeoutMs });
    if (result.pass) {
      counts.pass++;
      continue;
    }
    const rule = classify(test, rules);
    counts.differ++;
    if (rule) used.add(rule);
    const category = CATEGORIES.includes(rule?.category) ? rule.category : "engine-gap";
    counts[category]++;
    differences.push({
      name: test.name,
      tags: test.tags ?? [],
      category,
      rule: rule ? (rule.match.name !== undefined ? { name: rule.match.name } : { tag: rule.match.tag }) : null,
      reasonKey: rule && Object.hasOwn(reasons, rule.reason) ? rule.reason : null,
      reason: rule ? (reasons[rule.reason] ?? rule.reason) : "No rule explains this difference.",
      want: test.invalid ? { error: true } : { output: test.result },
      mirage: result.raised ? { error: result.error ?? true } : { output: result.output },
      dotliquid: rule?.dotliquid ?? null,
    });
  }
  return {
    suite: { path: suite, ...(rulesDocument.suite ?? {}) },
    reference: rulesDocument.reference ?? null,
    rules: rulesFile,
    counts,
    staleRules: rules.filter((rule) => rule.match?.name !== undefined && !used.has(rule)).map((rule) => rule.match.name),
    differences,
  };
}

const ELLIPSIS = String.fromCharCode(0x2026);
const BACKTICK = /\x60/g;
/** One value for a table cell: a JSON string for output (backticks escaped), "(error) Type" for a recorded .NET error. */
const show = (value) => {
  if (value == null) return "";
  if (typeof value === "object" && "error" in value)
    return typeof value.error === "string" && /^\w+(?:Exception|Error)\b/.test(value.error) ? `(error) ${value.error.split(":")[0]}` : "(error)";
  const json = JSON.stringify(typeof value === "object" ? value.output : value) ?? "";
  const text = json.length > 72 ? `${json.slice(0, 69)}${ELLIPSIS}"` : json;
  return text.replace(BACKTICK, String.fromCharCode(92) + "\x60");
};
/** The DotLiquid cell: one value when every reference build agrees, otherwise one per build. */
const showDotLiquid = (evidence) => {
  if (!evidence) return "";
  const values = REFERENCES.filter((reference) => reference in evidence).map((reference) => [reference, show(evidence[reference])]);
  if (!values.length) return "";
  if (values.length === REFERENCES.length && values.every(([, value]) => value === values[0][1])) return `${values[0][1]} (all)`;
  return values.map(([reference, value]) => `${reference}: ${value}`).join("; ");
};
const PIPE = /\|/g;
const cell = (value) => String(value ?? "").replace(PIPE, String.fromCharCode(92) + "|").replace(/\r?\n/g, " ");

function text(report) {
  const lines = [
    `golden-liquid conformance: ${report.counts.total} cases (${report.counts.expectError} expect an error)`,
    `pass ${report.counts.pass}, differ ${report.counts.differ}: ` + CATEGORIES.map((category) => `${category} ${report.counts[category]}`).join(", "),
  ];
  if (report.staleRules.length) lines.push(`stale rules (cases that now pass): ${report.staleRules.length}`);
  for (const category of CATEGORIES) {
    const items = report.differences.filter((difference) => difference.category === category);
    if (!items.length) continue;
    lines.push("", `## ${category} (${items.length})`);
    for (const item of items) lines.push(`- ${item.name}: ${item.reason}`);
  }
  return lines.join("\n") + "\n";
}

/** The generated case tables of docs/liquid-conformance.md. */
export function markdown(report) {
  const lines = [
    `Cases: ${report.counts.total} (${report.counts.expectError} expect an error). Pass: ${report.counts.pass}. Differ: ${report.counts.differ} (` +
      CATEGORIES.map((category) => `${category} ${report.counts[category]}`).join(", ") +
      ").",
  ];
  if (report.staleRules.length) lines.push("", `Stale rules (their cases now pass): ${report.staleRules.map(cell).join("; ")}.`);
  for (const category of CATEGORIES) {
    const items = report.differences.filter((difference) => difference.category === category);
    lines.push("", `### ${category} (${items.length})`, "");
    if (!items.length) {
      lines.push("None.");
      continue;
    }
    if (category === "platform-unsupported") {
      // One row per rule: the missing feature, its evidence and the cases it accounts for.
      const groups = new Map();
      for (const item of items) {
        const key = item.rule?.tag ?? item.rule?.name ?? item.name;
        if (!groups.has(key)) groups.set(key, { reason: item.reason, names: [] });
        groups.get(key).names.push(item.name);
      }
      lines.push("| Feature | Cases | Evidence | Case names |", "| --- | --- | --- | --- |");
      for (const [key, group] of groups) lines.push(`| ${cell(key)} | ${group.names.length} | ${cell(group.reason)} | ${cell(group.names.join("; "))} |`);
      continue;
    }
    // The evidence of each shared reason once, then one row per case naming its reason.
    const shared = new Map();
    for (const item of items) if (item.reasonKey) shared.set(item.reasonKey, { reason: item.reason, count: (shared.get(item.reasonKey)?.count ?? 0) + 1 });
    if (shared.size) {
      lines.push("| Reason | Cases | Evidence |", "| --- | --- | --- |");
      for (const [key, { reason, count }] of shared) lines.push(`| \`${key}\` | ${count} | ${cell(reason)} |`);
      lines.push("");
    }
    lines.push("| Case | Expected (Shopify) | Mirage | DotLiquid | Reason |", "| --- | --- | --- | --- | --- |");
    for (const item of items)
      lines.push(
        `| ${cell(item.name)} | ${cell(show(item.want))} | ${cell(show(item.mirage))} | ${cell(showDotLiquid(item.dotliquid))} | ${item.reasonKey ? `\`${item.reasonKey}\`` : cell(item.reason)} |`,
      );
  }
  return lines.join("\n") + "\n";
}

function parseArgs(argv) {
  const options = { format: "text", timeoutMs: 5000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === "--suite") options.suite = value();
    else if (arg === "--rules") options.rules = value();
    else if (arg === "--out") options.out = value();
    else if (arg === "--timeout") options.timeoutMs = Number(value());
    else if (arg === "--json") options.format = "json";
    else if (arg === "--markdown") options.format = "markdown";
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!options.suite)
    throw new Error("Usage: node mirage/liquid-conformance.mjs --suite <golden_liquid.json> [--rules FILE] [--json | --markdown] [--out FILE] [--timeout MS]");
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = await conformance(options);
  const body = options.format === "json" ? JSON.stringify(report, null, 2) + "\n" : options.format === "markdown" ? markdown(report) : text(report);
  if (options.out) await fs.writeFile(options.out, body);
  else process.stdout.write(body);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
