// @test-kind contract+security: only independently witnessed browser policy diagnostics with matching bytes and context are reconciled.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('a mapped captured script preserves native unload evidence across independent asset and document origins', async (t) => {
  const outputRoot = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-captured-policy-'));
  ownedFixture(t).remove(() => fs.rm(outputRoot, { recursive: true, force: true }));
  let remoteRequests = 0;
  const serveScript = (req, res) => {
    const url = new URL(req.url, 'http://asset-fixture.invalid');
    if (url.pathname === '/redirect.js') return res.writeHead(302, { location: '/client.js' }).end();
    return res
      .writeHead(200, { 'content-type': 'application/javascript' })
      .end(url.searchParams.has('changed') ? SCRIPT + '/* changed */' : SCRIPT);
  };
  const { origin: assetOrigin } = await loopbackServer(t, (req, res) => {
    remoteRequests++;
    serveScript(req, res);
  });
  const { origin: otherAssetOrigin } = await loopbackServer(t, serveScript);
  const referenceUrl = assetOrigin + '/client.js';
  const assetVariants = {
    default: referenceUrl,
    versioned: referenceUrl + '?version=1',
    changed: referenceUrl + '?changed=1',
    wrongOrigin: otherAssetOrigin + '/client.js',
    wrongPath: assetOrigin + '/elsewhere.js',
    redirect: assetOrigin + '/redirect.js',
  };
  const plainHeaders = { 'content-type': 'text/html' };
  const policyVariants = {
    defaultPolicy: plainHeaders,
    quotedPolicy: { ...plainHeaders, 'permissions-policy': 'fullscreen=("https://example.test, unload=(), x")' },
    invalidPolicy: { ...plainHeaders, 'permissions-policy': 'camera=!xx xx, unload=()' },
    invalidParameter: { ...plainHeaders, 'permissions-policy': 'unload=();bogus invalid' },
    invalidWhitespace: { ...plainHeaders, 'permissions-policy': 'camera=(),\u00a0unload=()' },
    changedPolicy: { ...plainHeaders, 'permissions-policy': 'unload=("https://example.test")' },
    withReporting: { ...plainHeaders, 'permissions-policy': 'unload=();report-to=policy, fullscreen=*' },
  };
  const opensChild = '<!doctype html><h1>Policy fixture</h1><iframe src="/nested"></iframe>';
  const { origin: referenceOrigin } = await loopbackServer(t, (req, res) => {
    const url = new URL(req.url, 'http://policy-fixture.invalid');
    const variant = url.searchParams.get('variant');
    if (url.pathname === '/embedded') return res.writeHead(200, POLICY_HEADER).end(opensChild);
    const script = assetVariants[variant] ?? referenceUrl;
    const headers = policyVariants[variant] ?? (url.pathname === '/nested' ? plainHeaders : POLICY_HEADER);
    return res.writeHead(200, headers).end(`<!doctype html><script src="${script}"></script>`);
  });
  const { origin: localUrl } = await loopbackServer(t, (req, res) => {
    const url = new URL(req.url, 'http://policy-fixture.invalid');
    if (['/mirrored/client.js', '/different.js'].includes(url.pathname)) return serveScript(req, res);
    if (url.pathname.startsWith('/__sim/api/')) return policyServer(req, res);
    const variant = url.searchParams.get('variant');
    if (url.pathname === '/embedded')
      return variant === 'childPolicy'
        ? res.writeHead(200, plainHeaders).end(opensChild.replace('/nested', '/nested?variant=childPolicy'))
        : res.writeHead(200, POLICY_HEADER).end(opensChild);
    if (variant === 'frame')
      return res
        .writeHead(200, POLICY_HEADER)
        .end('<!doctype html><h1>Policy fixture</h1><iframe src="/policy"></iframe>');
    const headers =
      policyVariants[variant] ??
      (url.pathname === '/nested' && variant !== 'childPolicy' ? plainHeaders : POLICY_HEADER);
    const script =
      {
        bytes: '/mirrored/client.js?changed=1',
        path: '/different.js',
        origin: referenceUrl,
      }[variant] ?? '/mirrored/client.js';
    const before = variant === 'authored' ? '<script>window.logAuthoredDiagnostic = true;</script>' : '';
    return res
      .writeHead(200, headers)
      .end(`<!doctype html><h1>Policy fixture</h1>${before}<script src="${script}"></script>`);
  });
  const capture = {
    referenceUrl,
    localPath: '/mirrored/client.js',
    sha256: createHash('sha256').update(SCRIPT).digest('hex'),
  };
  async function reference(variant, capturedAssets, path = '/policy') {
    const page = await browser.page(t);
    const observer = await observeBrowserPolicyDiagnostics(page, { origin: referenceOrigin, capturedAssets });
    ownedFixture(t).add(observer.dispose);
    const messages = [];
    page.on('console', (message) => messages.push(message.text()));
    await page.goto(referenceOrigin + path + '?variant=' + variant);
    const report = await observer.report();
    assert.equal(messages.filter((message) => message === MESSAGE).length, 1);
    return report;
  }

  assert.equal((await reference('default')).diagnostics.length, 0);
  const capturedAssets = [capture];
  const topReport = await reference('versioned', capturedAssets);
  const childReport = await reference('default', capturedAssets, '/embedded');
  const report = { ...topReport, diagnostics: [...topReport.diagnostics, ...childReport.diagnostics] };
  assert.equal(report.diagnostics.length, 2);
  assert.deepEqual(report.diagnostics[0].asset, { origin: assetOrigin, path: '/client.js', sha256: capture.sha256 });
  assert.match(report.diagnostics[0].policy.headerSha256, /^[\da-f]{64}$/);
  assert.equal(report.diagnostics[1].policy.path, '/embedded');
  const invalidPolicies = ['defaultPolicy', 'quotedPolicy', 'invalidPolicy', 'invalidParameter', 'invalidWhitespace'];
  for (const variant of ['changed', 'wrongOrigin', 'wrongPath', 'redirect', ...invalidPolicies])
    assert.equal((await reference(variant, capturedAssets)).diagnostics.length, 0, variant);
  const redirectCapture = { ...capture, referenceUrl: assetOrigin + '/redirect.js' };
  assert.equal(
    (await reference('redirect', [redirectCapture, { ...capture, localPath: '/alternate.js' }])).diagnostics.length,
    0,
  );

  const baseline = { referenceOrigin, report, capturedAssets };
  const run = (dir, flows, nativeBrowserDiagnosticBaseline = baseline) =>
    runAcceptance({
      localUrl,
      outputDir: path.join(outputRoot, dir),
      flows,
      nativeBrowserDiagnosticBaseline,
      timeout: ACCEPTANCE_HANG_GUARD_MS,
    });
  const beforeReplay = remoteRequests;
  const {
    flows: [matched, matchedChild, matchedWithReporting],
  } = await run('mapped', [
    policyFlow('mapped script'),
    policyFlow('mapped child', '/embedded'),
    policyFlow('unrelated reporting parameter', '/policy?variant=withReporting'),
  ]);
  assert.equal(remoteRequests, beforeReplay);
  assert.equal(matched.passed, true, matched.error);
  assert.equal(matchedChild.passed, true, matchedChild.error);
  assert.equal(matchedWithReporting.passed, true, matchedWithReporting.error);
  assert.ok(matched.consoleErrors.includes(MESSAGE));
  const [proof] = matched.nativeBrowserDiagnosticComparison.classified;
  assert.equal(proof.classification, PROVED.classification);
  assert.equal(proof.local.asset.path, capture.localPath);
  assert.equal(proof.local.asset.sha256, capture.sha256);
  assert.deepEqual(proof.reference.asset, report.diagnostics[0].asset);
  assert.deepEqual(proof.reference.policy, report.diagnostics[0].policy);
  assert.equal(proof.local.policy.headerSha256, proof.reference.policy.headerSha256);
  const variants = ['bytes', 'frame', 'path', 'origin', 'authored', 'changedPolicy', ...invalidPolicies];
  const { flows: rejected } = await run('unmatched', [
    ...variants.map((variant) => policyFlow(variant, '/policy?variant=' + variant)),
    policyFlow('shifted policy header', '/embedded?variant=childPolicy'),
  ]);
  for (const flow of rejected) {
    assert.equal(flow.passed, false, flow.name);
    assert.match(flow.error, /consoleErrors/, flow.name);
    assert.ok(
      flow.unexpectedConsoleErrors.some((item) => item.text === MESSAGE),
      flow.name,
    );
    if (flow.name !== 'authored') assert.deepEqual(flow.nativeBrowserDiagnosticComparison.classified, [], flow.name);
  }

  const invalidBaselines = {
    missingMapping: { referenceOrigin, report },
    wrongMapping: { ...baseline, capturedAssets: [{ ...capture, localPath: '/elsewhere.js' }] },
    wrongDigest: { ...baseline, capturedAssets: [{ ...capture, sha256: '0'.repeat(64) }] },
    wrongPolicy: {
      ...baseline,
      report: { ...report, diagnostics: [{ ...report.diagnostics[0], policy: { path: '/wrong', kind: 'top-level' } }] },
    },
    staleMappedDiagnostic: {
      ...baseline,
      report: { ...report, diagnostics: [{ ...report.diagnostics[0], observedAt: '2000-01-01T00:00:00.000Z' }] },
    },
  };
  const refused = await Promise.all(
    Object.entries(invalidBaselines).map(([name, invalid]) => run(name, [policyFlow(name)], invalid)),
  );
  for (const {
    flows: [flow],
  } of refused) {
    assert.equal(flow.passed, false, flow.name);
    assert.match(flow.error, /consoleErrors/);
    assert.deepEqual(flow.nativeBrowserDiagnosticComparison.classified, []);
  }

  const validationPage = await browser.page(t);
  const malformed = [
    [{ ...capture, referenceUrl: referenceUrl + '?version=1' }],
    [{ ...capture, referenceUrl: referenceUrl.replace('://', '://name@') }],
    [{ ...capture, referenceUrl: referenceOrigin + '/client.js' }],
    [{ ...capture, localPath: '//somewhere.invalid/client.js' }],
    [{ ...capture, sha256: 'bad' }],
    [capture, { ...capture, localPath: '/alternate.js' }],
    [capture, { ...capture, referenceUrl: otherAssetOrigin + '/client.js' }],
    Array(129).fill(capture),
  ];
  for (const entries of malformed)
    await assert.rejects(
      observeBrowserPolicyDiagnostics(validationPage, { origin: referenceOrigin, capturedAssets: entries }),
      /captured assets/,
    );
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
