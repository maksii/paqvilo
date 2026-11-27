// @test-kind contract: a browser keeps overlaying the code component kinds that still match the page while a changed kind goes to an invented loopback portal and is reported as a change to deploy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { proxiedOverlay } from './helpers/proxied-overlay.mjs';
import { createFixture } from '../test/fixture.mjs';

const SCHEMA = 'inv_Invented.Widget';
const BUNDLE = '0c0c0c0c-3333-4333-8333-000000000001';
const STYLE = '0c0c0c0c-3333-4333-8333-000000000002';
const SECOND_STYLE = '0c0c0c0c-3333-4333-8333-000000000003';

const declaration = JSON.stringify({
  Properties: [{ Name: 'value', Type: 6 }],
  Resources: [
    { Type: 0, Path: BUNDLE, LoadingOrder: 4, IsControlSpecific: true },
    { Type: 1, Path: STYLE, LoadingOrder: 4, IsControlSpecific: true },
    { Type: 1, Path: SECOND_STYLE, LoadingOrder: 4, IsControlSpecific: true },
  ],
  Name: SCHEMA,
  IsCdnControl: false,
})
  .replaceAll('&', '&amp;')
  .replaceAll('"', '&quot;');

test('real browser: a changed style list leaves the bundle local and names the manifest change to deploy', async (t) => {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-pcf-mismatch-')));
  const control = path.join(work, 'solution', 'Controls', SCHEMA);
  fs.mkdirSync(path.join(control, 'css'), { recursive: true });
  // The developer merged the two deployed style sheets into one: the local manifest declares a single css resource.
  fs.writeFileSync(
    path.join(control, 'ControlManifest.xml'),
    '<manifest><control namespace="Invented" constructor="Widget" version="1.0.0" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="bound" /><resources><code path="bundle.js" order="1" /><css path="css/widget.css" order="1" /></resources></control></manifest>',
  );
  fs.writeFileSync(
    path.join(control, 'ControlManifest.xml.data.xml'),
    `<CustomControl><Name>${SCHEMA}</Name><FileName>/Controls/${SCHEMA}/ControlManifest.xml</FileName></CustomControl>`,
  );
  fs.writeFileSync(path.join(control, 'bundle.js'), 'window.inventedWidget = "local bundle";\n');
  fs.writeFileSync(path.join(control, 'css', 'widget.css'), '#widget { color: rgb(0, 128, 0); }\n');
  const fx = createFixture();
  const requests = [];
  // The deployed portal: its two style sheets, its bundle and the page that declares them, by path.
  const deployed = new Map([
    [`/_pcfwebresource/${BUNDLE}`, ['application/javascript', 'window.inventedWidget = "online";']],
    [`/_pcfwebresource/${STYLE}`, ['text/css', '#widget { color: rgb(255, 0, 0); }']],
    [`/_pcfwebresource/${SECOND_STYLE}`, ['text/css', '#widget { font-weight: 700; }']],
    [
      '/widget/',
      [
        'text/html; charset=utf-8',
        `<!doctype html><html><head><title>Widget</title><link href="/_pcfwebresource/${STYLE}" rel="stylesheet"><link href="/_pcfwebresource/${SECOND_STYLE}" rel="stylesheet"></head><body><p id="widget">Widget</p><span id="field_Container"><script type="text/javascript" src="/_pcfwebresource/${BUNDLE}?1700000000000"></script><span id="PcfControlConfig_field" data-pcf-control="${declaration}"></span></span></body></html>`,
      ],
    ],
  ]);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push(url.pathname);
    const answer = deployed.get(url.pathname);
    if (answer) response.writeHead(200, { 'content-type': answer[0] }).end(answer[1]);
    else response.writeHead(404).end('loopback fixture: missing');
  });
  const { origin, session, page, faults } = await proxiedOverlay(t, server, {
    work,
    cleanup: () => fx.cleanup(),
    session: {
      sourceDir: fx.dir,
      siteName: 'pcf-mismatch-test',
      mirageConfig: { solutionRoots: [path.join(work, 'solution')] },
    },
  });
  await page.goto(origin + '/widget/', { waitUntil: 'load' });
  assert.equal(await page.evaluate(() => window.inventedWidget), 'local bundle');
  // The deployed style sheets still style the page.
  assert.deepEqual(
    await page.evaluate(() => {
      const style = getComputedStyle(document.getElementById('widget'));
      return [style.color, style.fontWeight];
    }),
    ['rgb(255, 0, 0)', '700'],
  );
  assert.equal(requests.includes(`/_pcfwebresource/${BUNDLE}`), false);
  assert.ok(requests.includes(`/_pcfwebresource/${STYLE}`) && requests.includes(`/_pcfwebresource/${SECOND_STYLE}`));
  assert.deepEqual(
    session.pcfResourcesFor(page).map((item) => [item.url.split('/').at(-1), item.kind ?? item.refused]),
    [
      [BUNDLE, 'code'],
      [STYLE, 'pcf-manifest-mismatch'],
      [SECOND_STYLE, 'pcf-manifest-mismatch'],
    ],
  );
  assert.deepEqual(
    session.rewriter.unsupported.filter((row) => row.pcfDeployment).map((row) => row.rel),
    [`@solution/Controls/${SCHEMA}/ControlManifest.xml`],
  );
  assert.deepEqual(faults, []);
});
