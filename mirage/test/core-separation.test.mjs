// The runtime is project-neutral: project-specific logic, names and data live
// in external project-owned data packs and reach the runtime only through the
// preset registry and its extension points (lib/extensions.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mirage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const anyCase = (term) => [...term].map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c)).join("");
/** A term as a word, a part between separators (plm-eaf, is_plm) or a camelCase part (isPlm, plmPortal, PLMPortal). */
const nameParts = (term, spellings = []) => {
  const upper = term.toUpperCase();
  return [
    `(?<![A-Za-z0-9#])${anyCase(term)}(?![A-Za-z0-9])`,
    `(?<=[a-z0-9])${term[0].toUpperCase()}${term.slice(1)}(?![a-z])`,
    `(?<=[a-z0-9])${upper}(?:(?![A-Za-z0-9])|(?=[A-Z][a-z]))`,
    `(?<![A-Za-z0-9#])(?:${[term, ...spellings].join("|")})(?=[A-Z])`,
    `(?<![A-Za-z0-9#])${upper}(?=[A-Z][a-z])`,
  ];
};
// EMA/PLM identifiers, as words, name parts or camelCase parts: the EMA publisher prefix, EMA, the
// euema hosts, PLM, eAF and Product UI (pui, or spelled out). Never in core files, comments included.
const PROJECT_SPECIFIC = new RegExp(
  [String.raw`\b${anyCase("ema")}_`, anyCase("euema"), String.raw`\bProduct UI\b`, ...nameParts("ema"), ...nameParts("plm"), ...nameParts("eaf", ["eAF"]), ...nameParts("pui")].join("|"),
  "g",
);
// The reference environment (dev02), the ESMP and IRIS sites and the PLM home page (myworkspace):
// comments may cite them as evidence ("observed on dev02"), code never uses them.
const CITED_ONLY = new RegExp([...nameParts("dev02"), ...nameParts("esmp"), ...nameParts("iris"), ...nameParts("myworkspace")].join("|"), "g");
const commentLine = (line) => /^\s*(?:\/\/|\/\*|\*|<!--)/.test(line);

async function coreFiles() {
  // The runtime (server.mjs, cli.mjs) and every root tool (bootstrap-report, parity-suite, ...).
  const files = (await fs.readdir(mirage, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => path.join(mirage, entry.name));
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(mjs|js|cjs|html|css|json)$/.test(entry.name)) files.push(full);
    }
  };
  await walk(path.join(mirage, "lib"));
  await walk(path.join(mirage, "admin"));
  return files;
}

test("core runtime files and root tools contain no EMA/PLM-specific identifiers", async () => {
  const findings = [];
  for (const file of await coreFiles()) {
    const text = await fs.readFile(file, "utf8");
    for (const [index, line] of text.split("\n").entries())
      for (const match of [...line.matchAll(PROJECT_SPECIFIC), ...(commentLine(line) ? [] : line.matchAll(CITED_ONLY))])
        findings.push(`${path.relative(mirage, file)}:${index + 1}: ${match[0]} in ${line.trim().slice(0, 120)}`);
  }
  assert.deepEqual(findings, []);
});

test("core runtime files never import data pack modules", async () => {
  const findings = [];
  for (const file of await coreFiles()) {
    if (!/\.m?js$/.test(file)) continue;
    const text = await fs.readFile(file, "utf8");
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g))
      if (/(^|\/)packs\//.test(match[1])) findings.push(`${path.relative(mirage, file)} imports ${match[1]}`);
  }
  assert.deepEqual(findings, []);
});

test("the guard recognises project-specific identifiers and ignores ordinary words", () => {
  const hits = (text, pattern = PROJECT_SPECIFIC) => [...text.matchAll(pattern)].map((match) => match[0]);
  assert.deepEqual(hits('row.ema_name; EMA scripts; https://euema-x; plm-eaf-scenario; eAF step; pui page'), ["ema_", "EMA", "euema", "plm", "eaf", "eAF", "pui"]);
  assert.deepEqual(hits("schema_name; leaf; email; implement; sample; Pull; input; #eaf7f0"), []);
  assert.deepEqual(hits("isPlm; eAFForm; emaWebApi; EMAWebApi; PLMPortal; hasPUI; Product UI - Banner"), ["Plm", "eAF", "ema", "EMA", "PLM", "PUI", "Product UI"]);
  assert.deepEqual(hits("EMAIL; getEmail; userPUID; Product UIs; SAMPLE"), []);
  assert.deepEqual(hits("--env dev02; /myworkspace/; ESMP site; iris-portal; isDev02; irisSettings", CITED_ONLY), ["dev02", "myworkspace", "ESMP", "iris", "Dev02", "iris"]);
  assert.deepEqual(hits("devices; workspace; myworkspaces; irises; dev021; esmpx; DEVICES", CITED_ONLY), []);
  assert.equal(commentLine("  // observed on dev02"), true);
  assert.equal(commentLine(" * dev02 sends"), true);
  assert.equal(commentLine('const origin = "dev02";'), false);
});
