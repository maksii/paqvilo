import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { stateFingerprint, observedEvidence, sourceFingerprint, cachedSourceFingerprint, implementationSourceFingerprint, cachedImplementationSourceFingerprint, implementationEvidence } from "../lib/evidence.mjs";

test("implementation hashes ignore only generated SDK directories and retain authored and mapped assemblies", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sim-sdk-fingerprint-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = ["test-sdk/Gate/obj/apphost.exe", "test-sdk/Gate/bin/Gate.dll", "test-sdk/Gate/Program.cs", "plugins/bin/Plugin.dll", "obj/runtime.mjs", "lib/handler.mjs"];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), "first");
  }
  let implementation = await implementationSourceFingerprint(root);
  let source = await sourceFingerprint(root);
  assert.equal(await cachedImplementationSourceFingerprint(root), implementation);
  assert.equal(await cachedSourceFingerprint(root), source);
  for (const file of files) {
    await fs.writeFile(path.join(root, file), "second");
    const next = await cachedImplementationSourceFingerprint(root);
    assert.equal(next, await implementationSourceFingerprint(root));
    if (file.startsWith("test-sdk/") && /\/(bin|obj)\//.test(file)) assert.equal(next, implementation, file);
    else assert.notEqual(next, implementation, file);
    const nextSource = await cachedSourceFingerprint(root);
    assert.notEqual(nextSource, source, `generic export hash must retain ${file}`);
    assert.equal(nextSource, await sourceFingerprint(root));
    implementation = next;
    source = nextSource;
  }
  await fs.rm(path.join(root, "test-sdk/Gate/obj"), { recursive: true });
  assert.equal(await cachedImplementationSourceFingerprint(root), implementation, "generated directory removal is irrelevant");
  await fs.writeFile(path.join(root, "test-sdk/Gate/New.cs"), "authored");
  assert.notEqual(await cachedImplementationSourceFingerprint(root), implementation, "new SDK source invalidates evidence");
});

test("fresh Mirage startup tolerates an exclusively locked SDK build product", { timeout: 60000 }, async t => {
  const sdkRoot = fileURLToPath(new URL("../test-sdk/", import.meta.url));
  const owned = await fs.mkdtemp(path.join(sdkRoot, "fingerprint-lock-"));
  const generated = path.join(owned, "obj", "apphost.exe");
  await fs.mkdir(path.dirname(generated));
  await fs.writeFile(generated, "owned SDK build product");
  let locker;
  t.after(async () => {
    if (locker && locker.exitCode === null) { const exited = once(locker, "exit"); locker.kill(); await exited; }
    await fs.rm(owned, { recursive: true, force: true });
  });
  if (process.platform === "win32") {
    locker = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", '$f=[System.IO.File]::Open($env:PAQVILO_TEST_LOCK,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None); try { [Console]::WriteLine("LOCKED"); [Console]::In.ReadLine() | Out-Null } finally { $f.Dispose() }'], { env: { ...process.env, PAQVILO_TEST_LOCK: generated }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const [ready] = await once(locker.stdout, "data");
    assert.match(ready.toString(), /LOCKED/);
    await assert.rejects(sourceFingerprint(fileURLToPath(new URL("../", import.meta.url))), { code: "EBUSY" });
  }
  const child = spawn(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../server.mjs", import.meta.url).href)}); console.log("MIRAGE_IMPORTED")`], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", value => { stdout += value; });
  child.stderr.on("data", value => { stderr += value; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  assert.match(stdout, /MIRAGE_IMPORTED/);
});

test("cached implementation fingerprints match full hashes and follow same-size edits, additions and removals", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sim-cached-fingerprint-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "admin"));
  await fs.writeFile(path.join(root, "admin", "app.mjs"), "export const version = 1;");
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, "node_modules", "ignored.js"), "ignored");
  const first = await cachedSourceFingerprint(root);
  assert.equal(first, await sourceFingerprint(root));
  assert.equal(await cachedSourceFingerprint(root), first, "unchanged files reuse the digest");
  await new Promise((resolve) => setTimeout(resolve, 25));
  await fs.writeFile(path.join(root, "admin", "app.mjs"), "export const version = 2;");
  const edited = await cachedSourceFingerprint(root);
  assert.notEqual(edited, first, "a same-size edit invalidates the cached digest");
  assert.equal(edited, await sourceFingerprint(root));
  await fs.writeFile(path.join(root, "admin", "style.css"), "body{}");
  const added = await cachedSourceFingerprint(root);
  assert.notEqual(added, edited);
  assert.equal(added, await sourceFingerprint(root));
  await fs.rm(path.join(root, "admin", "style.css"));
  assert.equal(await cachedSourceFingerprint(root), edited);
  await fs.writeFile(path.join(root, "node_modules", "ignored.js"), "still ignored");
  assert.equal(await cachedSourceFingerprint(root), edited, "excluded folders stay excluded");
});

test("an on-demand browser asset edit invalidates evidence from still-loaded modules", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sim-implementation-evidence-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "browser.js"), "window.localVersion = 1;");
  const loaded = await sourceFingerprint(root);
  const state = { config: {}, data: {}, status: { ...implementationEvidence(loaded, loaded), sourceFingerprint: "portal", localOrigin: "http://127.0.0.1:1" } };
  const report = { passed: true, verified: true, localOrigin: state.status.localOrigin, simulator: { stateSha256: stateFingerprint(state), sourceFingerprint: "portal", implementationFingerprint: state.status.implementationFingerprint } };
  assert.equal(observedEvidence(report, state).passed, true);
  await fs.writeFile(path.join(root, "browser.js"), "window.localVersion = 2;");
  Object.assign(state.status, implementationEvidence(loaded, await sourceFingerprint(root)));
  assert.equal(state.status.loadedImplementationFingerprint, loaded);
  assert.equal(state.status.implementationChanged, true);
  assert.equal(observedEvidence(report, state).passed, false);
});
test("observed parity becomes stale after identity, data, source or origin changes", () => {
  const state = {
    config: { identity: { id: "one" } },
    data: { contact: [] },
    status: {
      sourceFingerprint: "source",
      implementationFingerprint: "runtime",
      localOrigin: "http://127.0.0.1:1",
    },
  };
  const report = {
    passed: true,
    verified: true,
    localOrigin: state.status.localOrigin,
    simulator: {
      stateSha256: stateFingerprint(state),
      sourceFingerprint: "source",
      implementationFingerprint: "runtime",
    },
  };
  assert.equal(observedEvidence(report, state).passed, true);
  for (const mutate of [
    (s) => (s.config.identity.id = "two"),
    (s) => s.data.contact.push({ id: "new" }),
    (s) => (s.status.sourceFingerprint = "changed"),
    (s) => (s.status.implementationFingerprint = "changed"),
    (s) => delete s.status.implementationFingerprint,
    (s) => (s.status.localOrigin = "http://127.0.0.1:2"),
  ]) {
    const changed = structuredClone(state);
    mutate(changed);
    const result = observedEvidence(report, changed);
    assert.equal(result.passed, false);
    assert.equal(result.verified, false);
    assert.equal(result.stale, true);
    assert.equal(result.originalPassed, true);
  }
});
