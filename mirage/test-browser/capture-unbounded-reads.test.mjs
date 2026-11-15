// @test-kind contract: baseline capture and the parity verifier finish a step whose element or document body never appears (mirage/baseline-capture.mjs, mirage/verify.mjs)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { pageRunner } from '../baseline-capture.mjs';
import { verifyParity } from '../verify.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const origin = 'http://127.0.0.1:15154';
// The fixtures settle as soon as they are quiet. The bound is longer than the runner's hang guard, so it never decides
// a result: settle() requires a finite timeout.
const SETTLE = { quietMs: 5, timeout: 600_000 };
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40"/></svg>';
let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

async function fixture(t, contentType, body) {
  const context = await browser.newContext();
  ownedFixture(t).add(() => context.close());
  await context.route(origin + '/**', (route) => route.fulfill({ contentType, body }));
  return context.newPage();
}

test('an upload step whose file input never appears fails within the step timeout', async (t) => {
  const page = await fixture(t, 'text/html', '<!doctype html><title>Fixture</title><link rel="icon" href="data:,">');
  const result = await pageRunner(page, {
    origin,
    scenario: { id: 'invented/upload-missing', steps: [{ goto: '/' }, { upload: '#missing', files: [], timeout: 1 }] },
    settle: SETTLE,
  });
  assert.equal(result.summary.status, 'error');
  assert.equal(result.summary.stepOutcomes[1].status, 'error');
  assert.match(result.summary.problems.join('\n'), /waitFor.*#missing/s);
});

test('expected text on a document without a body is reported missing', async (t) => {
  const page = await fixture(t, 'image/svg+xml', SVG);
  const result = await pageRunner(page, {
    origin,
    scenario: { id: 'invented/svg-text', steps: [{ goto: '/' }], expect: { text: ['x'] } },
    settle: SETTLE,
    // A full-page screenshot of a document without a body never finishes; its guard ends it at once. The checks below
    // are decided before the screenshot starts.
    screenshotGuardMs: 1,
  });
  assert.equal(result.summary.status, 'failed');
  assert.equal(result.summary.problems[0], 'expected text missing: "x"');
});

test('the parity verifier records a document without a body as a readiness failure and an empty page', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-bodyless-verify-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(SVG));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  ownedFixture(t).add(() => new Promise((resolve) => server.close(resolve)));
  const served = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext();
  ownedFixture(t).add(() => context.close());
  // The attached browser is this test's own context, and the simulator state answers at once.
  t.mock.method(chromium, 'connectOverCDP', async () => ({ contexts: () => [context], close: async () => {} }));
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ config: { mode: 'local', pageMode: 'local' }, status: {}, diagnostics: [] }),
  );
  const result = await verifyParity({
    localUrl: served,
    origin: served,
    cdpUrl: 'http://127.0.0.1:9',
    outputDir: directory,
    viewport: { width: 800, height: 600 },
    settleMs: 0,
    allowLoopbackLive: true,
    // Bounds the asserted wait for a visible body. The assertions hold whether it or the navigation it shares the
    // bound with expires first.
    timeout: 2000,
  });
  assert.match(result.live.navigationError, /Timeout/);
  assert.equal(result.live.emptyPage, true);
  assert.equal(result.live.blockedPage, false);
});
