// @test-kind contract+security: only independently witnessed browser policy diagnostics with matching bytes and context are reconciled.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { observeBrowserPolicyDiagnostics, runAcceptance } from '../acceptance-api.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';
import { ACCEPTANCE_HANG_GUARD_MS, loopbackServer, sharedBrowser } from './shared-browser.mjs';

const browser = sharedBrowser({ headless: true });
const MESSAGE = 'Permissions policy violation: unload is not allowed in this document.';
const SCRIPT =
  "window.addEventListener('unload', () => {}); if (window.logAuthoredDiagnostic) console.error('Permissions policy violation: unload is not allowed in this document.');";
const STATE = {
  config: { mode: 'local', pageMode: 'local', endpoints: [] },
  status: { sourceFingerprint: 'policy-fixture', implementationFingerprint: 'policy-fixture' },
};
const PROVED = { classification: 'observed-browser-policy-diagnostic', source: 'violation', feature: 'unload' };
const POLICY_HEADER = { 'content-type': 'text/html', 'permissions-policy': 'unload=()' };

function policyServer(req, res) {
  const url = new URL(req.url, 'http://policy-fixture.invalid');
  if (url.pathname.startsWith('/__sim/api/'))
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(STATE));
  if (url.pathname === '/platform.js')
    return res
      .writeHead(200, { 'content-type': 'application/javascript' })
      .end(url.searchParams.has('changed') ? SCRIPT + '/* other bytes */' : SCRIPT);
  if (url.pathname === '/failed-resource') return res.writeHead(500, { 'content-type': 'application/json' }).end('{}');
  if (url.pathname === '/network-reset') return res.destroy();
  if (url.pathname === '/embedded')
    return res
      .writeHead(200, POLICY_HEADER)
      .end('<!doctype html><h1>Policy fixture</h1><iframe src="/framed-policy"></iframe>');
  const marker = '<!doctype html><h1>Policy fixture</h1>';
  if (url.pathname === '/framed-policy')
    return res.writeHead(200, { 'content-type': 'text/html' }).end(marker + '<script src="/platform.js"></script>');
  if (!['/policy', '/other'].includes(url.pathname)) return res.writeHead(404).end();
  const variant = url.searchParams.get('variant');
  if (variant === 'child') return res.writeHead(200, POLICY_HEADER).end(marker + '<iframe src="/policy"></iframe>');
  const script = variant === 'changed' ? '/platform.js?changed=true' : '/platform.js';
  const before = variant === 'authored' ? '<script>window.logAuthoredDiagnostic = true;</script>' : '';
  const extra =
    {
      request: "fetch('/failed-resource');",
      network: "fetch('/network-reset').catch(() => {});",
      error: "throw new Error('An unrelated JavaScript error');",
    }[variant] ?? '';
  return res
    .writeHead(200, POLICY_HEADER)
    .end(marker + before + `<script src="${script}"></script><script>${extra}</script>`);
}

const policyFlow = (name, path = '/policy') => ({
  name,
  steps: [
    { action: 'navigate', path },
    { action: 'text', selector: 'h1', value: 'Policy fixture' },
  ],
});

test('acceptance compares browser diagnostics to an independent page and retains raw failures and proofs', async (t) => {
  const outputRoot = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-policy-acceptance-'));
  ownedFixture(t).remove(() => fs.rm(outputRoot, { recursive: true, force: true }));
  const { origin: referenceOrigin } = await loopbackServer(t, policyServer);
  const { origin: localUrl } = await loopbackServer(t, policyServer);
  const referencePage = await browser.page(t);
  const observer = await observeBrowserPolicyDiagnostics(referencePage, { origin: referenceOrigin });
  ownedFixture(t).add(observer.dispose);
  const raw = [];
  referencePage.on('console', (message) => raw.push(message.text()));
  await referencePage.goto(referenceOrigin + '/policy');
  assert.equal((await observer.report()).diagnostics.length, 1);
  await referencePage.goto(referenceOrigin + '/embedded');
  const report = await observer.report();
  assert.deepEqual(
    raw.filter((message) => message === MESSAGE),
    [MESSAGE, MESSAGE],
  );
  assert.deepEqual(
    report.diagnostics.map(({ document }) => document.kind),
    ['top-level', 'child-frame'],
  );
  assert.equal(report.diagnostics[1].policy.path, '/embedded');
  const baseline = { referenceOrigin, report: JSON.parse(JSON.stringify(report)) };
  const run = (dir, flows, nativeBrowserDiagnosticBaseline) =>
    runAcceptance({
      localUrl,
      outputDir: path.join(outputRoot, dir),
      flows,
      timeout: ACCEPTANCE_HANG_GUARD_MS,
      nativeBrowserDiagnosticBaseline,
    });
  const compared = await run(
    'compared',
    [
      policyFlow('top'),
      policyFlow('frame', '/embedded'),
      policyFlow('changed bytes', '/policy?variant=changed'),
      policyFlow('changed frame', '/policy?variant=child'),
      policyFlow('changed path', '/other'),
      policyFlow('authored message', '/policy?variant=authored'),
      policyFlow('HTTP failure', '/policy?variant=request'),
      policyFlow('network failure', '/policy?variant=network'),
      policyFlow('script failure', '/policy?variant=error'),
    ],
    baseline,
  );
  const [top, frame, changedBytes, changedFrame, changedPath, authored, request, network, script] = compared.flows;
  for (const flow of [top, frame, authored, request, network, script]) {
    assert.ok(flow.consoleErrors.includes(MESSAGE));
    const [proof] = flow.nativeBrowserDiagnosticComparison.classified;
    assert.deepEqual(
      { classification: proof.classification, source: proof.local.source, feature: proof.local.feature },
      PROVED,
    );
    assert.equal(proof.reference.origin, referenceOrigin);
    assert.equal(proof.local.asset.sha256, report.diagnostics[0].asset.sha256);
  }
  for (const flow of [top, frame]) assert.equal(flow.passed, true, JSON.stringify(flow));
  for (const flow of [changedBytes, changedFrame, changedPath, authored, request, network, script])
    assert.equal(flow.passed, false);
  for (const flow of [changedBytes, changedFrame, changedPath])
    assert.deepEqual(flow.nativeBrowserDiagnosticComparison.classified, []);
  assert.ok(authored.unexpectedConsoleErrors.some((item) => item.text === MESSAGE && item.argumentCount === 1));
  assert.equal(new Set(authored.consoleMessages.filter(({ text }) => text === MESSAGE).map(({ url }) => url)).size, 1);
  assert.match(request.error, /failedResponses/);
  assert.match(network.error, /failedRequests/);
  assert.ok(network.failedRequests.some(({ url }) => new URL(url).pathname === '/network-reset'));
  assert.match(script.error, /pageErrors/);

  const badWitnesses = {
    absent: undefined,
    stale: { ...baseline, report: { ...report, observedAt: '2000-01-01T00:00:00.000Z' } },
    staleDiagnostic: {
      ...baseline,
      report: { ...report, diagnostics: [{ ...report.diagnostics[0], observedAt: '2000-01-01T00:00:00.000Z' }] },
    },
    wrongOrigin: { ...baseline, referenceOrigin: localUrl },
    wrongBrowser: { ...baseline, report: { ...report, browser: { ...report.browser, product: 'Chrome/1.0.0.0' } } },
    wrongFeature: {
      ...baseline,
      report: { ...report, diagnostics: [{ ...report.diagnostics[0], feature: 'camera' }] },
    },
  };
  const rejected = await Promise.all(
    Object.entries(badWitnesses).map(([name, invalid]) => run(name, [policyFlow(name)], invalid)),
  );
  for (const {
    flows: [flow],
  } of rejected) {
    assert.equal(flow.passed, false, flow.name);
    assert.match(flow.error, /consoleErrors/);
    assert.ok(flow.unexpectedConsoleErrors.some((item) => item.text === MESSAGE));
  }
});
