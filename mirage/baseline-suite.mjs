#!/usr/bin/env node
/**
 * Baseline suite: capture every scenario of a matrix on one side into deterministic evidence
 * folders, then compare sides with the allowlist.
 *
 * Live side (the reference portal) runs through the user's own signed-in browser profile via a
 * browser bridge that exposes a Playwright page (for example `@playwright/mcp --extension`); the
 * bridge command comes from the matrix (`live.command`, `live.args`) so no profile name lives in
 * toolkit code. Live writes are refused unless `--allow-writes` names the run as authorised and
 * the request falls inside the matrix `writeScope`; every other non-GET is aborted and recorded.
 *
 * node mirage/baseline-suite.mjs capture --matrix FILE --out DIR --side live [--allow-writes] [--label live|live-2] [--ids FILE] [--only IDS|@FILE]
 * node mirage/baseline-suite.mjs capture --matrix FILE --out DIR --side mirage --config FILE --site ID [--source DIR] [--state FILE] [--label mirage] [--ids FILE] [--only IDS|@FILE] [--headed]
 * node mirage/baseline-suite.mjs compare --matrix FILE --out DIR [--live live] [--mirage mirage] [--second-live live-2] [--allowlist FILE] [--only IDS|@FILE]
 */
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { captureScenario, pageRunnerSource, runnerOptions, writeCapture } from "./baseline-capture.mjs";
import { compareScenario, loadAllowlist, summarize, summaryMarkdown } from "./baseline-compare.mjs";
import { startMcpServer } from "./mcp-stdio.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// `--only a,b,c` or `--only @file` (one scenario id per line; `#` comments) selects scenarios.
const list = (value) => {
  if (!value) return null;
  const text = String(value).startsWith("@") ? readFileSync(String(value).slice(1), "utf8").replace(/#[^\n]*/g, "\n") : String(value);
  return text.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
};

export function validateMatrix(matrix) {
  if (!matrix || matrix.version !== 1 || !Array.isArray(matrix.scenarios) || !matrix.scenarios.length) throw new Error("A version 1 matrix with scenarios is required.");
  const ids = new Set();
  for (const scenario of matrix.scenarios) {
    if (typeof scenario.id !== "string" || !/^[a-z0-9][a-z0-9/._-]{0,160}$/i.test(scenario.id)) throw new Error(`Scenario id is invalid: ${scenario.id}`);
    if (ids.has(scenario.id)) throw new Error(`Duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    if (!Array.isArray(scenario.steps) || !scenario.steps.length) throw new Error(`Scenario ${scenario.id} needs steps.`);
    if (scenario.persona && !matrix.personas?.[scenario.persona]) throw new Error(`Scenario ${scenario.id} uses unknown persona ${scenario.persona}.`);
  }
  for (const pattern of matrix.writeScope?.paths ?? []) new RegExp(pattern);
  if (matrix.origin && !/^https:\/\/[^/?#]+$/.test(matrix.origin)) throw new Error("matrix.origin must be a bare HTTPS origin.");
  return matrix;
}

/** Folder of one scenario on one side: <out>/<scenario id segments>/<label>. */
export const scenarioDir = (outDir, scenario, label) => path.join(outDir, ...scenario.id.split("/"), label);

async function runHook(command, { persona, cwd } = {}) {
  if (!command) return { skipped: true };
  const resolved = command.replace(/\{persona\}/g, persona ?? "");
  const [file, ...args] = resolved.match(/(?:[^\s"]+|"[^"]*")+/g).map((item) => item.replace(/^"|"$/g, ""));
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: cwd ?? process.cwd(), stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve({ code, output: out.slice(-2000) }) : reject(new Error(`Hook failed (${code}): ${resolved}\n${out.slice(-2000)}`))));
  });
}

/** Loopback receiver for raw evidence posted by the runner inside the bridge process. */
async function startSaver() {
  const token = randomBytes(16).toString("hex");
  let waiting = null;
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/capture" || request.headers["x-baseline-token"] !== token || !waiting) {
      response.writeHead(403).end();
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        waiting.resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(204).end();
      } catch (error) {
        waiting.reject(error);
        response.writeHead(400).end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/capture`;
  return {
    url,
    token,
    expect() {
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
      });
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function liveSide({ matrix, allowWrites, cwd, signInOut = null }) {
  const bridge = matrix.live;
  if (!bridge?.command) throw new Error("matrix.live.command is required for the live side (a browser bridge that exposes a Playwright page, such as @playwright/mcp --extension).");
  const stderr = [];
  const client = startMcpServer({ command: bridge.command === "node" ? process.execPath : bridge.command, args: bridge.args ?? [], cwd: bridge.cwd ? path.resolve(cwd, bridge.cwd) : cwd, onStderr: (text) => stderr.push(text.slice(0, 300)) });
  await client.initialize();
  const tools = new Set((await client.listTools()).map((tool) => tool.name));
  const runTool = bridge.tool ?? "browser_run_code_unsafe";
  if (!tools.has(runTool)) throw new Error(`The browser bridge offers no ${runTool} tool.`);
  const saver = await startSaver();
  const source = pageRunnerSource();
  const runInBridge = async (scenario, { ids = {}, allowWrites: writes = allowWrites } = {}) => {
    const options = runnerOptions({ scenario, origin: matrix.origin, ids, matrix, allowWrites: writes });
    const code = `async (page) => {\n  const run = ${source};\n  const result = await run(page, ${JSON.stringify(options)});\n  const posted = await fetch(${JSON.stringify(saver.url)}, { method: "POST", headers: { "content-type": "application/json", "x-baseline-token": ${JSON.stringify(saver.token)} }, body: JSON.stringify(result) });\n  return JSON.stringify({ ...result.summary, posted: posted.status });\n}`;
    const received = saver.expect();
    const text = await client.callTool(runTool, { code }, (scenario.timeout ?? 240) * 1000 + 60000);
    return Promise.race([received, sleep(30000).then(() => { throw new Error(`Bridge returned without posting evidence: ${text.slice(0, 300)}`); })]);
  };
  // Optional scripted portal sign-in through the profile's identity provider. No credentials are
  // involved: the profile's SSO either completes or the run stops and names the human step.
  const fail = async (message, result, folder) => {
    if (signInOut && result) await writeCapture(result, { outDir: path.join(signInOut, folder), origin: matrix.origin, side: folder, meta: { runtime: "reference" } }).catch(() => {});
    await saver.close();
    await client.close();
    throw new Error(message);
  };
  const ensureSignedIn = async () => {
    if (!bridge.signIn) return;
    const expect = { absent: ["form[action*='/Account/Login/ExternalLogin']", ...(bridge.signIn.expectAbsent ?? [])], present: bridge.signIn.expectPresent ?? [] };
    // Already signed in: the first navigation alone shows the signed-in markers, so the provider click is skipped.
    const first = bridge.signIn.steps.find((step) => step.goto);
    let result = first ? await runInBridge({ id: "sign-in", steps: [first, { wait: 1500 }], expect }, { allowWrites: false }) : { summary: { status: "skipped" } };
    if (result.summary.status !== "captured") result = await runInBridge({ id: "sign-in", steps: bridge.signIn.steps, expect }, { allowWrites: false });
    if (result.summary.status !== "captured") await fail(`Portal sign-in did not complete through the browser profile (${result.summary.problems.join("; ")}). Sign in once in that profile (credential or MFA prompt), then rerun.`, result, "sign-in");
  };
  const signOut = async () => {
    if (!bridge.signOut) throw new Error("matrix.live.signOut is required for anonymous scenarios on the live side (steps that sign the portal session out).");
    const expect = { absent: bridge.signIn?.expectPresent ?? [], ...(bridge.signOut.expect ?? {}) };
    const result = await runInBridge({ id: "sign-out", steps: bridge.signOut.steps, expect }, { allowWrites: false });
    if (result.summary.status !== "captured") await fail(`Portal sign-out did not complete (${result.summary.problems.join("; ")}).`, result, "sign-out");
  };
  // Role changes reach the portal through its cache: a persona is in effect only once its verification probe passes.
  const verifyPersona = async (name, verify, ids) => {
    const attempts = verify.attempts ?? 12;
    let result;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      result = await runInBridge({ id: `persona-${name}`, steps: verify.steps, expect: verify.expect ?? {} }, { ids, allowWrites: false });
      if (result.summary.status === "captured") return attempt;
      await sleep(verify.delay ?? 15000);
    }
    await fail(`Persona ${name} did not take effect on the portal after ${attempts} probes (${result.summary.problems.join("; ")}).`, result, `persona-${name}`);
  };
  await ensureSignedIn();
  return {
    name: "live",
    async persona(name, { ids = {} } = {}) {
      const persona = matrix.personas?.[name] ?? {};
      await runHook(matrix.hooks?.livePersona, { persona: name, cwd: matrix.hooks?.cwd ? path.resolve(cwd, matrix.hooks.cwd) : cwd });
      if (persona.anonymous) await signOut();
      else await ensureSignedIn();
      if (persona.verify) await verifyPersona(name, persona.verify, ids);
    },
    async reset() {
      const options = { cwd: matrix.hooks?.cwd ? path.resolve(cwd, matrix.hooks.cwd) : cwd };
      // Dataverse answers an occasional transient 500: one retry before the scenario is charged with the failure.
      await runHook(matrix.hooks?.liveReset, options).catch(() => sleep(5000).then(() => runHook(matrix.hooks?.liveReset, options)));
    },
    async capture(scenario, { outDir, ids, label, meta }) {
      const result = await runInBridge(scenario, { ids });
      return writeCapture(result, { outDir, origin: matrix.origin, side: label, meta: { ...meta, origin: new URL(matrix.origin).hostname.replace(/^[^.]+/, "{site}"), runtime: "reference", bridge: bridge.name ?? "browser-bridge" } });
    },
    diagnostics: () => stderr.slice(-20),
    async close() {
      await saver.close();
      await client.close();
    },
  };
}

async function mirageSide({ matrix, config, site, env, source, state, headed, workDir }) {
  const { startIsolatedMirage, createIdentityController } = await import("./parity-suite.mjs");
  const { chromium } = await import("playwright-core");
  const { browserLaunchOptions } = await import("./lib/browser-launch.mjs");
  let catalogue = null;
  if (site) {
    const { loadConfig } = await import("../lense/config.mjs");
    catalogue = await loadConfig({ site, env, config });
  }
  const sourceDir = path.resolve(source ?? catalogue?.sourceDir);
  const siteMirage = catalogue?.mirageConfig ?? null;
  let roots = null;
  if (siteMirage) {
    const { resolveSolutionRoots } = await import("./lib/solution-roots.mjs");
    roots = await resolveSolutionRoots({ sourceDir, catalogue: siteMirage, cacheFile: path.join(workDir, "cache", "solution-sources.json") });
  }
  const preset = matrix.mirage?.preset ?? siteMirage?.preset ?? null;
  const owned = await startIsolatedMirage({
    sourceDir,
    dataPacks: siteMirage?.dataPacks ?? [],
    baselineState: state ? path.resolve(state) : undefined,
    ...(roots ? { solutionRoots: roots.roots, solutionOrder: roots.order } : {}),
    ...(siteMirage?.observed ? { observed: siteMirage.observed } : {}),
    preset,
    origin: matrix.origin ?? "https://baseline.invalid",
    workDir,
  });
  const identity = createIdentityController(owned.url);
  const browser = await chromium.launch(browserLaunchOptions({ headless: !headed }));
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const status = await (await fetch(owned.url + "/__sim/api/state?summary=1")).json();
  const csrf = () => owned.app.state().csrf;
  return {
    name: "mirage",
    url: owned.url,
    async persona(name) {
      const persona = matrix.personas?.[name];
      if (!persona) throw new Error(`Unknown persona ${name}`);
      if (persona.anonymous) {
        await identity.restore();
        return;
      }
      if (persona.roles) await identity.mirror({ contactId: persona.mirageContact ?? status.config?.identity?.contactId, roles: persona.roles });
      else await identity.signInAs(persona.mirageContact);
      await identity.use("signed-in");
    },
    async reset() {
      const response = await fetch(owned.url + "/__sim/api/reset", { method: "POST", headers: { "x-sim-csrf": csrf() } });
      if (!response.ok) throw new Error(`Mirage reset failed (${response.status})`);
      if (preset) await owned.app.applyPreset(preset);
      const config = await fetch(owned.url + "/__sim/api/config", { method: "PATCH", headers: { "content-type": "application/json", "x-sim-csrf": csrf() }, body: JSON.stringify({ mode: "local", pageMode: "local", live: { allowWrites: false } }) });
      if (!config.ok) throw new Error(`Mirage configuration failed (${config.status})`);
    },
    async capture(scenario, { outDir, ids, label, meta }) {
      await context.clearCookies();
      const cookie = identity.cookie();
      if (cookie) await context.addCookies([{ name: cookie.name, value: cookie.value, url: owned.url }]);
      const page = await context.newPage();
      try {
        return await captureScenario(page, scenario, { origin: owned.url, outDir, ids, side: label, matrix, allowWrites: true, meta: { ...meta, origin: "{mirage}", runtime: "mirage", preset, solutionRoots: owned.solutionRoots.map((root) => path.basename(root)), sourceFingerprint: status.status?.sourceFingerprint ?? null, implementationFingerprint: status.status?.implementationFingerprint ?? null } });
      } finally {
        await page.close().catch(() => {});
      }
    },
    diagnostics: () => [],
    async close() {
      await identity.restore().catch(() => {});
      await browser.close().catch(() => {});
      await owned.app.close().catch(() => {});
      if (owned.workspace) await fs.rm(owned.workspace, { recursive: true, force: true }).catch(() => {});
    },
  };
}

export async function captureMatrix({ matrix, side, outDir, label, ids = {}, only = null }) {
  const results = [];
  let currentPersona = Symbol("none");
  // Persona switches are the expensive step on a live portal (its permission cache lags role changes by
  // minutes), so scenarios run grouped by persona in first-appearance order; the order within a persona is kept.
  const personaOrder = [];
  for (const scenario of matrix.scenarios) if (!personaOrder.includes(scenario.persona ?? null)) personaOrder.push(scenario.persona ?? null);
  const selected = matrix.scenarios
    .filter((scenario) => !only || only.includes(scenario.id))
    .map((scenario, index) => ({ scenario, index }))
    .sort((a, b) => personaOrder.indexOf(a.scenario.persona ?? null) - personaOrder.indexOf(b.scenario.persona ?? null) || a.index - b.index)
    .map(({ scenario }) => scenario);
  for (const scenario of selected) {
    const folder = scenarioDir(outDir, scenario, label);
    const personaName = scenario.persona ?? null;
    const summary = { id: scenario.id, folder: path.relative(outDir, folder), ms: {} };
    const timed = async (name, work) => {
      const started = Date.now();
      try {
        return await work();
      } finally {
        summary.ms[name] = Date.now() - started;
      }
    };
    try {
      if (personaName !== currentPersona) {
        await timed("persona", () => side.persona(personaName ?? "anonymous", { ids }));
        currentPersona = personaName;
      }
      if (scenario.reset !== false) await timed("reset", () => side.reset());
      const capture = await timed("capture", () => side.capture(scenario, { outDir: folder, ids, label, meta: { persona: personaName, component: scenario.component ?? null, variation: scenario.variation ?? null, state: scenario.state ?? null } }));
      Object.assign(summary, { status: capture.status, problems: capture.problems, requests: capture.requests, elements: capture.elements, blockedWrites: capture.blockedWrites?.length ?? 0 });
    } catch (error) {
      Object.assign(summary, { status: "error", problems: [String(error.message).slice(0, 500), ...side.diagnostics().slice(-3)] });
    }
    results.push(summary);
    console.log(JSON.stringify({ scenario: scenario.id, side: label, status: summary.status, problems: summary.problems ?? [], ms: summary.ms }));
    await sleep(matrix.delayMs ?? 250);
  }
  return results;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      matrix: { type: "string" }, out: { type: "string" }, side: { type: "string" }, label: { type: "string" }, "allow-writes": { type: "boolean" }, ids: { type: "string" }, only: { type: "string" },
      config: { type: "string" }, site: { type: "string" }, env: { type: "string" }, source: { type: "string" }, state: { type: "string" }, headed: { type: "boolean" }, "work-dir": { type: "string" },
      live: { type: "string" }, mirage: { type: "string" }, allowlist: { type: "string" }, "second-live": { type: "string" },
    },
  });
  const action = positionals[0];
  if (!["capture", "compare"].includes(action) || !values.matrix || !values.out) throw new Error("Usage: suite.mjs capture|compare --matrix FILE --out DIR ...");
  const matrixFile = path.resolve(values.matrix);
  const matrix = validateMatrix(JSON.parse(await fs.readFile(matrixFile, "utf8")));
  const outDir = path.resolve(values.out);
  const only = list(values.only);
  if (action === "capture") {
    // `run` is a short token scenarios embed in values that must be unique per run yet equal on both sides.
    const ids = { run: matrix.runToken ?? "r1", ...(values.ids ? JSON.parse(await fs.readFile(values.ids, "utf8")) : {}) };
    let side;
    if (values.side === "live") {
      if (!matrix.origin) throw new Error("matrix.origin (HTTPS reference origin) is required for the live side.");
      side = await liveSide({ matrix, allowWrites: Boolean(values["allow-writes"]), cwd: path.dirname(matrixFile), signInOut: path.join(outDir, "_sign-in") });
    } else if (values.side === "mirage") {
      side = await mirageSide({ matrix, config: values.config, site: values.site, env: values.env, source: values.source, state: values.state, headed: Boolean(values.headed), workDir: path.resolve(values["work-dir"] ?? path.join(outDir, ".runtime")) });
    } else throw new Error("--side must be live or mirage.");
    const label = values.label ?? values.side;
    const startedAt = new Date().toISOString();
    let results;
    try {
      results = await captureMatrix({ matrix, side, outDir, label, ids, only });
    } finally {
      await side.close();
    }
    const run = { version: 1, action, side: values.side, label, startedAt, finishedAt: new Date().toISOString(), allowWrites: Boolean(values["allow-writes"]), scenarios: results, totals: { captured: results.filter((r) => r.status === "captured").length, failed: results.filter((r) => r.status === "failed").length, error: results.filter((r) => r.status === "error").length, blockedWrites: results.reduce((sum, r) => sum + (r.blockedWrites ?? 0), 0) } };
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, `run-${label}.json`), JSON.stringify(run, null, 2));
    console.log(JSON.stringify({ run: path.join(outDir, `run-${label}.json`), totals: run.totals }));
    process.exitCode = run.totals.error ? 2 : 0;
    return;
  }
  const allowlist = values.allowlist ? await loadAllowlist(values.allowlist) : { entries: [] };
  const report = { version: 1, action, generatedAt: new Date().toISOString(), live: values.live ?? "live", mirage: values.mirage ?? "mirage", allowlist: values.allowlist ? path.resolve(values.allowlist) : null, scenarios: [] };
  for (const scenario of matrix.scenarios.filter((item) => !only || only.includes(item.id))) {
    const liveDir = scenarioDir(outDir, scenario, report.live);
    const mirageDir = scenarioDir(outDir, scenario, report.mirage);
    const secondDir = values["second-live"] ? scenarioDir(outDir, scenario, values["second-live"]) : null;
    const result = await compareScenario({ scenario, liveDir, mirageDir, secondDir, allowlist });
    await fs.writeFile(path.join(outDir, ...scenario.id.split("/"), "diff.json"), JSON.stringify(result, null, 2));
    report.scenarios.push({ id: scenario.id, verdict: result.verdict, counts: result.counts, signatures: result.signatures, reason: result.reason });
    console.log(JSON.stringify({ scenario: scenario.id, verdict: result.verdict, counts: result.counts, reason: result.reason }));
  }
  Object.assign(report, summarize(report));
  await fs.writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(outDir, "summary.md"), summaryMarkdown(report));
  console.log(JSON.stringify({ report: path.join(outDir, "report.json"), totals: report.totals, topSignatures: report.bySignature.slice(0, 10) }));
  process.exitCode = report.totals.fail || report.totals.error ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
