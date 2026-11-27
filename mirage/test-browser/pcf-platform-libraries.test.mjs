// @test-kind observation: the Power Pages host has window.React, window.ReactDOM and window.FluentUIReact on every page with a code component and mounts standard controls that declare React and virtual controls (paqvilo-developer pcf-parity summary-D round 2, summary-B field host); Mirage serves them from invented local project files
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

const control = (constructor, type, libraries, body, top = '') => ({
  [`Controls/inv_Invented.${constructor}/ControlManifest.xml`]: `<manifest><control namespace="Invented" constructor="${constructor}" control-type="${type}"><property name="value" of-type="SingleLine.Text" usage="input"/><resources><code path="bundle.js" order="1"/>${libraries}</resources></control></manifest>`,
  [`Controls/inv_Invented.${constructor}/ControlManifest.xml.data.xml`]: `<CustomControl><Name>inv_Invented.${constructor}</Name></CustomControl>`,
  [`Controls/inv_Invented.${constructor}/bundle.js`]: `${top}ComponentFramework.registerControl('Invented.${constructor}', class { ${body} getOutputs() { return {}; } destroy() {} });`,
});
const REACT = '<platform-library name="React" version="16.14.0"/>';

async function portalWith(t, copy, pcf, before) {
  const dir = await fs.realpath(await makeTemporaryDirectory(path.join(os.tmpdir(), 'pcf-platform-')));
  await writeFixtureFiles(path.join(dir, 'solution'), {
    ...control(
      'Plain',
      'standard',
      '',
      `init(c, n, s, container) { window.plain = { React: typeof window.React, ReactDOM: typeof window.ReactDOM, Fluent: typeof window.FluentUIReact }; container.textContent = 'plain'; } updateView() {}`,
    ),
    ...control(
      'Standard',
      'standard',
      REACT,
      `init(c, n, s, container) { container.textContent = 'standard ' + R.version; } updateView() {}`,
      // A bundle built with React as an external reads the global when it loads.
      'var R = React;',
    ),
    ...control(
      'Older',
      'standard',
      '<platform-library name="React" version="16.8.6"/>',
      `init(c, n, s, container) { container.textContent = 'older ' + window.React.version; } updateView() {}`,
    ),
    ...control(
      'Virtual',
      'virtual',
      REACT,
      `init() {} updateView(context) { return 'element of ' + context.parameters.value.raw; }`,
    ),
  });
  await writeFixtureFiles(path.join(dir, 'libraries'), {
    'React@16.14.0.js': "window.React = { version: '16.14.0', createElement: function () {} };",
    'ReactDOM@16.14.0.js':
      "window.ReactDOM = { render: function (element, node) { node.textContent = 'rendered ' + element; }, unmountComponentAtNode: function () {} };",
    'FluentUIReact@8.122.8.js': 'window.FluentUIReact = {};',
  });
  await writeFixtureFiles(path.join(dir, 'portal'), {
    'website.yml': 'adx_websiteid: invented\nadx_name: Invented\n',
    'web-pages/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main\n',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main\n',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main\n',
    'Main.webtemplate.source.html': `<html><body>${copy}</body></html>`,
  });
  const runtime = await createSimulator({
    sourceDir: path.join(dir, 'portal'),
    solutionRoots: [path.join(dir, 'solution')],
    ...(pcf ? { pcf: pcfSettings(pcf, 'pcf', dir) } : {}),
    watch: false,
    port: 0,
  });
  let browser;
  ownedFixture(t).add(() =>
    drainFixture([() => browser?.close(), () => runtime.close(), () => fs.rm(dir, { recursive: true, force: true })]),
  );
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await before?.(page);
  await page.goto(runtime.url);
  return { page, runtime, errors };
}

test('supplied platform libraries are globals on the page and mount standard and virtual controls', async (t) => {
  const copy = [
    '<section id="plain">{% codecomponent name:inv_Invented.Plain %}</section>',
    '<section id="standard">{% codecomponent name:inv_Invented.Standard %}</section>',
    '<section id="older">{% codecomponent name:inv_Invented.Older %}</section>',
    '<section id="virtual">{% codecomponent name:inv_Invented.Virtual value:\'v1\' %}</section>',
  ].join('');
  const { page, errors, runtime } = await portalWith(t, copy, {
    platformLibraries: [
      './libraries/React@16.14.0.js',
      './libraries/ReactDOM@16.14.0.js',
      './libraries/FluentUIReact@8.122.8.js',
    ],
  });
  await page.waitForFunction(
    () =>
      window.plain &&
      document.querySelector('#virtual [data-pcf-schema]')?.textContent &&
      document.querySelector('#older [data-pcf-schema]')?.textContent &&
      document.querySelector('#standard [data-pcf-schema]')?.textContent,
  );
  assert.deepEqual(await page.evaluate(() => window.plain), { React: 'object', ReactDOM: 'object', Fluent: 'object' });
  // The supplied Fluent UI file does not register itself: the page lists it as the live page does.
  assert.deepEqual(await page.evaluate(() => window.__packages__), { '@fluentui/react': ['8.122.8'] });
  assert.equal(await page.locator('#standard [data-pcf-schema]').textContent(), 'standard 16.14.0');
  // A declared older React gets the page's 16.14.0, as on Power Pages, with an info diagnostic.
  assert.equal(await page.locator('#older [data-pcf-schema]').textContent(), 'older 16.14.0');
  const { diagnostics } = await (await fetch(runtime.url + '/_sim/api/diagnostics')).json();
  assert.ok(diagnostics.some((entry) => entry.code === 'PCF_PLATFORM_LIBRARY_VERSION' && entry.severity === 'info'));
  assert.equal(await page.locator('#virtual [data-pcf-schema]').textContent(), 'rendered element of v1');
  // Each library is loaded once although three controls name it.
  assert.equal(
    await page.evaluate(() => [...document.scripts].filter((node) => /\/React\.js$/.test(node.src)).length),
    1,
  );
  assert.deepEqual(errors, []);
});

test('without the library files a React control is refused with the setting that supplies them', async (t) => {
  const { page, runtime } = await portalWith(
    t,
    '<section id="virtual">{% codecomponent name:inv_Invented.Virtual %}</section>',
  );
  const alert = await page.locator('#virtual [role="alert"]').textContent();
  assert.match(alert, /Supply React@16\.14\.0\.js, ReactDOM@16\.14\.0\.js as project files in pcf\.platformLibraries/);
  const { diagnostics } = await (await fetch(runtime.url + '/_sim/api/diagnostics')).json();
  assert.ok(diagnostics.some((entry) => entry.reason === 'PCF_VIRTUAL_UNSUPPORTED'));
});

// @test-kind contract: Mirage's host loads a Liquid host's bundle itself when its native script element did not register the control
test('a bundle whose native address fails is loaded from the catalogue instead', async (t) => {
  const { page, errors } = await portalWith(
    t,
    '<section id="plain">{% codecomponent name:inv_Invented.Plain %}</section>',
    null,
    (page) => page.route('**/_pcfwebresource/**', (route) => route.fulfill({ status: 404, body: 'missing' })),
  );
  await page.waitForFunction(() => document.querySelector('#plain [data-pcf-schema]')?.textContent === 'plain');
  assert.deepEqual(errors, []);
});
