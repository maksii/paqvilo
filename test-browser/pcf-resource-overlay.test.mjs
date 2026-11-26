// @test-kind contract: a browser overlays declared PCF code, CSS and explicitly requested XML resources against an invented loopback portal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { proxiedOverlay } from './helpers/proxied-overlay.mjs';
import { createFixture } from '../test/fixture.mjs';
import verify from '../lense/commands/verify.mjs';
import { browserChannel } from '../mirage/lib/browser-launch.mjs';

const SCHEMA = 'inv_Invented.Widget';
const BUNDLE = '0b0b0b0b-2222-4222-8222-000000000001';
const STYLE = '0b0b0b0b-2222-4222-8222-000000000002';
const RESX = '0b0b0b0b-2222-4222-8222-000000000003';
const OTHER_RESX = '0b0b0b0b-2222-4222-8222-000000000004';

/** The declaration a live page writes for a code component, HTML-entity encoded. */
const declaration = (ambiguous = false) =>
  JSON.stringify({
    Resources: [
      { Type: 3, Path: '{"Id":"ManifestTemplate","Data":{}}', LoadingOrder: 1, IsControlSpecific: false },
      { Type: 0, Path: BUNDLE, LoadingOrder: 4, IsControlSpecific: true },
      { Type: 1, Path: STYLE, LoadingOrder: 4, IsControlSpecific: true },
      { Type: 2, Path: RESX, LoadingOrder: 4, IsControlSpecific: true },
      ...(ambiguous ? [{ Type: 2, Path: OTHER_RESX, LoadingOrder: 4, IsControlSpecific: true }] : []),
    ],
    Name: SCHEMA,
    IsCdnControl: false,
  })
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;');

test('real browser: a declared code component loads its bundle and style sheet from the Solution files', async (t) => {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-pcf-overlay-')));
  const control = path.join(work, 'solution', 'Controls', SCHEMA);
  fs.mkdirSync(path.join(control, 'css'), { recursive: true });
  fs.mkdirSync(path.join(control, 'strings'), { recursive: true });
  fs.writeFileSync(
    path.join(control, 'ControlManifest.xml'),
    '<manifest><control namespace="Invented" constructor="Widget" version="1.0.0" display-name-key="Widget" description-key="Invented." control-type="standard" api-version="1.3.18"><property name="value" display-name-key="Value" description-key="Value." of-type="SingleLine.Text" usage="bound" required="false" /><resources><code path="bundle.js" order="1" /><css path="css/widget.css" order="1" /><resx path="strings/Widget.1033.resx" version="1.0.0" /></resources></control></manifest>',
  );
  fs.writeFileSync(
    path.join(control, 'ControlManifest.xml.data.xml'),
    `<?xml version="1.0" encoding="utf-8"?><CustomControl><Name>${SCHEMA}</Name><FileName>/Controls/${SCHEMA}/ControlManifest.xml</FileName></CustomControl>`,
  );
  fs.writeFileSync(path.join(control, 'bundle.js'), 'window.inventedWidget = "local bundle";\n');
  fs.writeFileSync(path.join(control, 'css', 'widget.css'), '#widget { color: rgb(0, 128, 0); }\n');
  fs.writeFileSync(
    path.join(control, 'strings', 'Widget.1033.resx'),
    '<root><data name="Greeting"><value>Local</value></data></root>',
  );
  const fx = createFixture();
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push(url.pathname);
    if (url.pathname === `/_pcfwebresource/${BUNDLE}`)
      response.writeHead(200, { 'content-type': 'application/javascript' }).end('window.inventedWidget = "online";');
    else if (url.pathname === `/_pcfwebresource/${STYLE}`)
      response.writeHead(200, { 'content-type': 'text/css' }).end('#widget { color: rgb(255, 0, 0); }');
    else if (url.pathname === `/_pcfwebresource/${RESX}`)
      response
        .writeHead(200, { 'content-type': 'application/xml' })
        .end('<root><data name="Greeting"><value>Upstream</value></data></root>');
    else if (['/widget/', '/fr/widget/', '/ambiguous/'].includes(url.pathname))
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          `<!doctype html><html><head><title>Widget</title><link href="/_pcfwebresource/${STYLE}" rel="stylesheet"></head><body><p id="widget">Widget</p><span id="field_Container"><script type="text/javascript" src="/_pcfwebresource/${BUNDLE}?1700000000000"></script><span id="PcfControlConfig_field" data-pcf-control="${declaration(url.pathname === '/ambiguous/')}"></span></span></body></html>`,
        );
    else response.writeHead(404).end('loopback fixture: missing');
  });
  const { origin, session, page, faults } = await proxiedOverlay(t, server, {
    work,
    cleanup: () => fx.cleanup(),
    session: {
      sourceDir: fx.dir,
      siteName: 'pcf-overlay-test',
      mirageConfig: { solutionRoots: [path.join(work, 'solution')] },
    },
  });
  // The load event follows the parser-blocking bundle and the style sheet of the document.
  await page.goto(origin + '/widget/', { waitUntil: 'load' });
  assert.equal(await page.evaluate(() => window.inventedWidget), 'local bundle');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('widget')).color), 'rgb(0, 128, 0)');
  assert.ok(!requests.some((pathname) => pathname.startsWith('/_pcfwebresource/')), requests.join(', '));
  const items = session.requestSummary(page).items.filter((item) => item.url.includes('/_pcfwebresource/'));
  assert.deepEqual(items.map((item) => [item.class, item.kind, item.control, item.rel]).sort(), [
    ['local', 'pcf-resource', SCHEMA, `@solution/Controls/${SCHEMA}/bundle.js`],
    ['local', 'pcf-resource', SCHEMA, `@solution/Controls/${SCHEMA}/css/widget.css`],
  ]);
  assert.deepEqual(faults, []);

  const requestResource = (accept) =>
    page.evaluate(
      async ({ url, accept }) => {
        const resource = await fetch(url, { headers: { Accept: accept }, cache: 'no-store' });
        return { text: await resource.text(), contentType: resource.headers.get('content-type') };
      },
      { url: `/_pcfwebresource/${RESX}`, accept },
    );
  const localResx = await requestResource('application/xml');
  assert.match(localResx.text, /<value>Local<\/value>/);
  assert.match(localResx.contentType, /^application\/xml\b/);
  assert.equal(requests.includes(`/_pcfwebresource/${RESX}`), false);
  assert.match((await requestResource('application/json, application/xml;q=0')).text, /<value>Upstream<\/value>/);
  await page.goto(origin + '/ambiguous/', { waitUntil: 'load' });
  assert.equal(await page.evaluate(() => window.inventedWidget), 'local bundle');
  assert.match((await requestResource('application/xml')).text, /<value>Upstream<\/value>/);
  assert.equal(session.pcfResourcesFor(page).find((item) => item.url.endsWith(RESX)).refused, 'pcf-manifest-mismatch');

  // Verification can create its copy through an aliased temporary directory, as on Windows with 8.3 TEMP.
  const verifyTemp = path.join(work, 'verify-temp');
  const verifyAlias = path.join(work, 'verify-temp-alias');
  fs.mkdirSync(verifyTemp);
  fs.symlinkSync(verifyTemp, verifyAlias, 'junction');
  t.mock.method(os, 'tmpdir', () => verifyAlias);
  const verifyCfg = {
    ...session.cfg,
    stateDir: path.join(work, 'verify-state'),
    browser: { channel: browserChannel(), profileDir: path.join(work, 'verify-profile') },
  };
  const evidence = [];
  t.mock.method(console, 'log', (line) => evidence.push(JSON.parse(line)));
  t.mock.method(console, 'error', () => {});
  const outcome = await verify(verifyCfg, { json: true, 'verify-path': ['/widget/', '/fr/widget/'] });
  assert.equal(outcome, 0, JSON.stringify(evidence[0]?.reports.map((report) => report.error ?? report.checks)));
  assert.equal(evidence.length, 1);
  assert.deepEqual(evidence[0].paths, [origin + '/widget/', origin + '/fr/widget/']);
  for (const report of evidence[0].reports) {
    const checks = report.checks.filter((check) => check.name.startsWith('PCF resource ('));
    assert.deepEqual(checks.map((check) => [check.name.split(' ')[2], check.ok]).sort(), [
      ['(code)', true],
      ['(css)', true],
    ]);
  }
  assert.equal(fs.readFileSync(path.join(control, 'bundle.js'), 'utf8'), 'window.inventedWidget = "local bundle";\n');
});
