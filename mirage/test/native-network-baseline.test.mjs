import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { AssetCache } from "../lib/asset-cache.mjs";
import { captureRichTextConfiguration } from "../lib/richtext-config.mjs";
import { sourceFingerprint } from "../lib/evidence.mjs";
import {
  validateNativeNetworkBaseline,
  classifyNativeNetworkFailures,
} from "../lib/native-network-baseline.mjs";

const font = "/uclient/resources/styles/CRMMDL2.woff",
  skin =
    "/webresources/msdyn_/RichTextEditorControl/libs/ckeditor_latest/skins/superowa/editor.css",
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "pp-native-network-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourceDir = path.join(directory, "source");
  await fs.mkdir(sourceDir);
  const file = path.join(sourceDir, "configuration.js");
  await fs.writeFile(
    file,
    JSON.stringify({ defaultSupportedProps: { height: 145 } }),
  );
  const resource = {
      file,
      url: "/configuration.js",
      name: "configuration.js",
      metadata: { adx_filename: "sample_eafRTEConfiguration.js" },
    },
    portal = { sourceDir, webFiles: [resource] },
    origin = "https://portal.example.test";
  const cache = await new AssetCache({
      directory: path.join(directory, "assets"),
      origin,
    }).init(),
    observed = Buffer.from(
      JSON.stringify({ defaultSupportedProps: { height: 195 } }),
    );
  const capture = await captureRichTextConfiguration(
    cache,
    {
      origin,
      request: async () => ({
        status: 200,
        headers: { "content-type": "application/javascript" },
        body: observed,
      }),
    },
    { portal, resource, configUrl: "/WebResources/sample_eafRTEConfiguration.js" },
  );
  const css = Buffer.from(
    `@font-face {font-family:'CRMMDL2';src:url("${font}") format('woff')}`,
  );
  await cache.capture([skin], {
    origin,
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/css" },
      body: css,
    }),
  });
  const fingerprint = await sourceFingerprint(sourceDir),
    report = {
      version: 1,
      observedAt: "2026-10-07T13:00:00Z",
      origin,
      sourceFingerprint: fingerprint,
      sourceFingerprintAfter: fingerprint,
      fingerprintKind: "export-file-bytes",
      sourceUnchanged: true,
      errors: [],
      configuration: {
        observedPath: capture.baseline.observedPath,
        sha256: hash(observed),
        sourceSha256: capture.baseline.sourceSha256,
      },
      linkedCSS: [
        {
          path: skin,
          status: 200,
          sha256: hash(css),
          bytes: css.length,
          declaresFont: true,
        },
      ],
      fontResponses: [
        { path: font, method: "GET", status: 404, requestKey: "native1" },
      ],
      networkFailures: [
        {
          path: font,
          method: "GET",
          status: 404,
          requestKey: "native1",
          correlatedResponse: true,
          errorText: "net::ERR_ABORTED",
        },
      ],
    };
  return {
    directory,
    file,
    cache,
    portal,
    report,
    baseline: capture.baseline,
    options: {
      report,
      portal,
      cache,
      activeConfigurations: [capture.baseline],
      localOrigin: "http://127.0.0.1:8787",
    },
  };
}

test("only the exact static font GET/404 and native same-request network abort can be compared, with raw failures retained", async (t) => {
  const f = await fixture(t),
    validation = await validateNativeNetworkBaseline(f.options);
  assert.equal(validation.valid, true);
  const paired = {
    kind: "network",
    path: font,
    method: "GET",
    status: 404,
    requestKey: "local1",
    errorText: "net::ERR_ABORTED",
    correlatedResponse: {
      requestKey: "local1",
      path: font,
      method: "GET",
      status: 404,
    },
  };
  const failures = [
    { kind: "http", path: font, method: "GET", status: 404 },
    paired,
    {
      kind: "http",
      url: f.options.localOrigin + font,
      method: "GET",
      status: 404,
    },
    { kind: "http", path: "/_api/contacts", method: "GET", status: 404 },
  ];
  const classified = await classifyNativeNetworkFailures(failures, validation);
  assert.strictEqual(classified.rawFailures, failures);
  assert.equal(classified.expectedNativeFailures.length, 3);
  assert.deepEqual(classified.unexpectedFailures, [failures[3]]);
  assert.strictEqual(classified.expectedNativeFailures[0].failure, failures[0]);
  assert.equal(
    classified.expectedNativeFailures[0].observation.configurationSha256,
    f.report.configuration.sha256,
  );
});

test("console/page failures, missing HTTP proof, mutation methods and unrelated/ambiguous paths never match", async (t) => {
  const f = await fixture(t),
    validation = await validateNativeNetworkBaseline(f.options),
    base = { kind: "http", path: font, method: "GET", status: 404 };
  const failures = [
    { ...base, kind: "console" },
    { ...base, kind: "pageerror" },
    { ...base, kind: undefined },
    { ...base, status: undefined },
    { ...base, status: 403 },
    { ...base, method: undefined },
    { ...base, method: "POST" },
    { ...base, method: "HEAD" },
    { ...base, path: "/_api/contacts" },
    { ...base, path: "/__sim/forms/entityform/a/submit" },
    { ...base, path: font + "?t=1" },
    { ...base, path: font + "#x" },
    { ...base, path: "/uclient/resources/styles/other.woff" },
    { ...base, path: "http://other.test" + font },
    { ...base, path: "/other/../uclient/resources/styles/CRMMDL2.woff" },
    { ...base, failure: "net::ERR_ABORTED" },
    {
      ...base,
      kind: "network",
      requestKey: "local1",
      errorText: "net::ERR_ABORTED",
    },
    {
      ...base,
      kind: "network",
      requestKey: "local1",
      errorText: "net::ERR_ABORTED",
      correlatedResponse: {
        requestKey: "other",
        path: font,
        method: "GET",
        status: 404,
      },
    },
  ];
  const result = await classifyNativeNetworkFailures(failures, validation);
  assert.deepEqual(result.expectedNativeFailures, []);
  assert.deepEqual(result.unexpectedFailures, failures);
});

test("a native HTTP404 without a native requestfailed proof cannot classify a local abort", async (t) => {
  const f = await fixture(t);
  f.report.networkFailures = [];
  const validated = await validateNativeNetworkBaseline(f.options);
  assert.equal(validated.valid, true);
  const failure = {
    kind: "network",
    path: font,
    method: "GET",
    status: 404,
    requestKey: "local1",
    failure: "net::ERR_ABORTED",
    correlatedResponse: {
      requestKey: "local1",
      path: font,
      method: "GET",
      status: 404,
    },
  };
  const result = await classifyNativeNetworkFailures([failure], validated);
  assert.deepEqual(result.unexpectedFailures, [failure]);
});

test("source edits after validation revoke classification instead of accepting a stale observation", async (t) => {
  const f = await fixture(t),
    validated = await validateNativeNetworkBaseline(f.options);
  await fs.writeFile(
    path.join(f.portal.sourceDir, "changed.liquid"),
    "changed source",
  );
  const result = await classifyNativeNetworkFailures(
    [{ kind: "http", path: font, method: "GET", status: 404 }],
    validated,
  );
  assert.equal(result.validation.valid, false);
  assert.equal(
    result.validation.diagnostics[0].code,
    "NATIVE_BASELINE_SOURCE_CHANGED",
  );
  assert.equal(result.unexpectedFailures.length, 1);
});

test("changed active configuration, CSS integrity and missing cached bytes fail closed", async (t) => {
  for (const mutation of ["configuration", "css", "missing-config"])
    await t.test(mutation, async (st) => {
      const f = await fixture(st),
        validated = await validateNativeNetworkBaseline(f.options);
      if (mutation === "configuration")
        f.options.activeConfigurations = [
          { ...f.baseline, sha256: "0".repeat(64) },
        ];
      else if (mutation === "css")
        await fs.writeFile(
          path.join(f.cache.directory, f.report.linkedCSS[0].sha256 + ".bin"),
          "modified stylesheet",
        );
      else
        await fs.unlink(
          path.join(f.cache.directory, f.baseline.sha256 + ".bin"),
        );
      const result = await classifyNativeNetworkFailures(
        [{ kind: "http", path: font, method: "GET", status: 404 }],
        validated,
      );
      assert.equal(result.validation.valid, false);
      assert.equal(result.expectedNativeFailures.length, 0);
      assert.equal(result.unexpectedFailures.length, 1);
    });
});

test("malformed observations, wrong origins, stale hashes and unpaired native aborts are rejected", async (t) => {
  for (const mutation of [
    (r) => delete r.fontResponses[0].method,
    (r) => r.errors.push("native page error"),
    (r) => (r.sourceFingerprintAfter = "0".repeat(64)),
    (r) => (r.origin = "https://another.example.test"),
    (r) => (r.configuration.sourceSha256 = "0".repeat(64)),
    (r) => (r.linkedCSS[0].sha256 = "0".repeat(64)),
    (r) => (r.linkedCSS[0].path = "/unrelated.css"),
    (r) => (r.linkedCSS[0].declaresFont = false),
    (r) => (r.networkFailures[0].requestKey = "unpaired"),
    (r) => (r.networkFailures[0].status = undefined),
    (r) => (r.networkFailures[0].errorText = "net::ERR_FAILED"),
  ]) {
    const f = await fixture(t);
    mutation(f.report);
    const validation = await validateNativeNetworkBaseline(f.options);
    assert.equal(validation.valid, false);
    assert.ok(validation.diagnostics.length > 0);
  }
  const forged = await classifyNativeNetworkFailures(
    [{ kind: "http", path: font, method: "GET", status: 404 }],
    { valid: true },
  );
  assert.equal(forged.expectedNativeFailures.length, 0);
});
