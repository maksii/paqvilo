import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stateFingerprint, observedEvidence, sourceFingerprint, cachedSourceFingerprint, implementationEvidence } from "../lib/evidence.mjs";

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
