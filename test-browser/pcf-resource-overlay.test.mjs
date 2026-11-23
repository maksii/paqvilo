// @test-kind contract: a real browser receives a code component's local bundle and style sheet for the /_pcfwebresource/<guid> addresses a loopback portal page declares (invented control, loopback fixture)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { proxiedOverlay } from './helpers/proxied-overlay.mjs';
import { createFixture } from '../test/fixture.mjs';

const SCHEMA = 'inv_Invented.Widget';
const BUNDLE = '0b0b0b0b-2222-4222-8222-000000000001';
const STYLE = '0b0b0b0b-2222-4222-8222-000000000002';

/** The declaration a live page writes for a code component, HTML-entity encoded. */
const declaration = () =>
  JSON.stringify({
    Resources: [
      { Type: 3, Path: '{"Id":"ManifestTemplate","Data":{}}', LoadingOrder: 1, IsControlSpecific: false },
      { Type: 0, Path: BUNDLE, LoadingOrder: 4, IsControlSpecific: true },
      { Type: 1, Path: STYLE, LoadingOrder: 4, IsControlSpecific: true },
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
  fs.writeFileSync(
    path.join(control, 'ControlManifest.xml'),
    '<manifest><control namespace="Invented" constructor="Widget" version="1.0.0" display-name-key="Widget" description-key="Invented." control-type="standard" api-version="1.3.18"><property name="value" display-name-key="Value" description-key="Value." of-type="SingleLine.Text" usage="bound" required="false" /><resources><code path="bundle.js" order="1" /><css path="css/widget.css" order="1" /></resources></control></manifest>',
  );
  fs.writeFileSync(
    path.join(control, 'ControlManifest.xml.data.xml'),
    `<?xml version="1.0" encoding="utf-8"?><CustomControl><Name>${SCHEMA}</Name><FileName>/Controls/${SCHEMA}/ControlManifest.xml</FileName></CustomControl>`,
  );
  fs.writeFileSync(path.join(control, 'bundle.js'), 'window.inventedWidget = "local bundle";\n');
  fs.writeFileSync(path.join(control, 'css', 'widget.css'), '#widget { color: rgb(0, 128, 0); }\n');
  const fx = createFixture();
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push(url.pathname);
    if (url.pathname === `/_pcfwebresource/${BUNDLE}`)
      response.writeHead(200, { 'content-type': 'application/javascript' }).end('window.inventedWidget = "online";');
    else if (url.pathname === `/_pcfwebresource/${STYLE}`)
      response.writeHead(200, { 'content-type': 'text/css' }).end('#widget { color: rgb(255, 0, 0); }');
    else if (url.pathname === '/widget/')
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          `<!doctype html><html><head><title>Widget</title><link href="/_pcfwebresource/${STYLE}" rel="stylesheet"></head><body><p id="widget">Widget</p><span id="field_Container"><script type="text/javascript" src="/_pcfwebresource/${BUNDLE}?1700000000000"></script><span id="PcfControlConfig_field" data-pcf-control="${declaration()}"></span></span></body></html>`,
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
});
