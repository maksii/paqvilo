import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { ownedFixture } from "../testing/owned-fixture.mjs";

function ownedProcess(t, args, { signal = t.signal } = {}) {
  const child = spawn(process.execPath, args, {
    windowsHide: true,
    signal,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = chunk => { output = (output + chunk).slice(-4000); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const closed = new Promise(resolve => child.once("close", resolve));
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  ownedFixture(t).add(async () => {
    if (child.pid !== undefined && !child.killed && child.exitCode === null && child.signalCode === null) {
      assert.ok(child.kill(), "Owned capture process termination must be accepted");
    }
    // 'close' also waits for stdout/stderr to finish, unlike 'exit'.
    await closed;
  });
  return { child, closed, done, output: () => output };
}

async function outputDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paqvilo-capture-exit-"));
  ownedFixture(t).remove(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("capture CLI reports failed assertions without losing completed evidence", { timeout: 90000 }, async t => {
  const dir = await outputDirectory(t);
  const source = path.join(dir, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "website.yml"), "adx_websiteid: invented-site\nadx_name: Invented\n");
  await fs.writeFile(path.join(source, "Home.webpage.yml"), "adx_webpageid: invented-home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\n");
  await fs.writeFile(path.join(source, "Home.webpage.copy.html"), '<main><h1 id="present">Invented capture</h1></main>');
  const matrix = path.join(dir, "matrix.json");
  await fs.writeFile(matrix, JSON.stringify({
    version: 1,
    personas: { anonymous: { anonymous: true } },
    delayMs: 0,
    scenarios: [
      { id: "invented/failed", steps: [{ goto: "/" }], expect: { present: ["#absent"] } },
      { id: "invented/passed", steps: [{ goto: "/" }], expect: { present: ["#present"] } },
      { id: "invented/error", steps: [{ goto: "/" }, { click: "#absent", timeout: 100 }] },
    ],
  }));
  const script = fileURLToPath(new URL("../baseline-suite.mjs", import.meta.url));
  for (const [label, only, expected] of [
    ["failed", "invented/failed,invented/passed", 1],
    ["passed", "invented/passed", 0],
    ["error", "invented/error", 2],
  ]) {
    const out = path.join(dir, label);
    const child = ownedProcess(t, [script, "capture", "--matrix", matrix, "--source", source,
      "--out", out, "--side", "mirage", "--label", label, "--only", only]);
    const code = await child.done;
    const run = JSON.parse(await fs.readFile(path.join(out, "run-" + label + ".json"), "utf8"));
    assert.equal(code, expected, JSON.stringify({ label, totals: run.totals, output: child.output().slice(-1000) }));
    if (label === "failed") {
      assert.deepEqual(run.scenarios.map(item => item.status), ["failed", "captured"]);
      assert.equal(run.totals.failed, 1);
      assert.equal(run.totals.captured, 1);
      const meta = JSON.parse(await fs.readFile(path.join(out, "invented/failed/failed/meta.json"), "utf8"));
      assert.equal(meta.status, "failed");
      assert.ok(meta.problems.some(item => item.includes("#absent")));
      assert.ok((await fs.readdir(out)).some(name => name.startsWith("run-failed-")));
    }
    if (label === "error") assert.equal(run.totals.error, 1);
  }
});

test("aborting an owned capture process drains its pipes before removing output", { timeout: 10000 }, async t => {
  const dir = await outputDirectory(t);
  const controller = new AbortController();
  const child = ownedProcess(t, ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"], { signal: controller.signal });
  let closed = false;
  child.closed.then(() => { closed = true; });
  ownedFixture(t).remove(() => assert.ok(closed, "Output removal must follow owned process close"));
  await once(child.child.stdout, "data", { signal: t.signal });
  await fs.writeFile(path.join(dir, "owned-output.txt"), "invented");
  controller.abort();
  await assert.rejects(child.done, { name: "AbortError" });
});
