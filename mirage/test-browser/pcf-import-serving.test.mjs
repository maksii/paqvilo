// @test-kind contract: Paqvilo serves a pcf-scripts build output, its style-referenced files and the unregistered-bundle hint to a real browser, with invented controls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { pcfSettings } from '../lib/pcf-sources.mjs';
import { ownedFixture, drainFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { writeFixtureFiles } from '../test/support/pcf-fixture-files.mjs';

// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

test('a build output control loads the files its style refers to and an unregistered bundle names the build mode', async (t) => {
  const dir = await fs.realpath(await makeTemporaryDirectory(path.join(os.tmpdir(), 'pcf-serving-')));
  let runtime, browser;
  ownedFixture(t).add(() =>
    drainFixture([() => browser?.close(), () => runtime?.close(), () => fs.rm(dir, { recursive: true, force: true })]),
  );
  const controls = path.join(dir, 'build', 'out', 'controls');
  const control = (constructor, resources) =>
    `<manifest><control namespace="Invented" constructor="${constructor}" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="input"/><resources>${resources}</resources></control></manifest>`;
  await writeFixtureFiles(controls, {
    'Styled/ControlManifest.xml': control(
      'Styled',
      '<code path="bundle.js" order="1"/><css path="css/styled.css" order="1"/>',
    ),
    'Styled/bundle.js': `ComponentFramework.registerControl('Invented.Styled', class {
      init(context, notify, state, container) { container.className = 'invented-styled'; container.textContent = 'styled'; window.styledMounted = true; }
      updateView() {} getOutputs() { return {}; } destroy() {} });`,
    'Styled/css/styled.css':
      '.invented-styled{display:block;width:10px;height:10px;background-image:url("../img/back.png")}',
    'Styled/img/back.png': PNG,
    'Unregistered/ControlManifest.xml': control('Unregistered', '<code path="bundle.js" order="1"/>'),
    'Unregistered/bundle.js': 'window.unregisteredLoaded = true;',
  });
  const portal = path.join(dir, 'portal');
  await writeFixtureFiles(portal, {
    'website.yml': 'adx_websiteid: invented\nadx_name: Invented\n',
    'web-pages/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main\n',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main\n',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main\n',
    'Main.webtemplate.source.html':
      '<html><body><section id="styled">{% codecomponent name:inv_Invented.Styled %}</section><section id="unregistered">{% codecomponent name:inv_Invented.Unregistered %}</section></body></html>',
  });
  runtime = await createSimulator({
    sourceDir: portal,
    pcf: pcfSettings({ sources: [{ path: './build', publisherPrefix: 'inv' }] }, 'pcf', dir),
    watch: false,
    port: 0,
  });
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  const page = await browser.newPage();
  // The background image is requested once the styled container renders.
  const image = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/img/back.png'));
  await page.goto(runtime.url);
  await page.waitForFunction(() => window.styledMounted === true);
  const served = await image;
  assert.equal(served.status(), 200);
  assert.equal(served.headers()['content-type'], 'image/png');
  const message = page.locator('#unregistered [data-pcf-error="true"]');
  await message.waitFor();
  assert.match(await message.textContent(), /did not register Invented\.Unregistered.*production mode/);
});
