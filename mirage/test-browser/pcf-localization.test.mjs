import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { importCodeComponents, renderCodeComponent } from '../lib/code-components.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

test('PCF localized instances keep languages, missing keys and empty labels across updates and teardown', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-localization-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'Controls', 'tst_Synthetic.Localized');
  await fs.mkdir(path.join(dir, 'strings'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'ControlManifest.xml'),
    '<manifest><control namespace="Synthetic" constructor="Localized" control-type="standard"><property name="value" display-name-key="Empty" of-type="SingleLine.Text" usage="bound"/><resources><resx path="strings/Labels.1036.resx" version="2.0.0"/><code path="bundle.js"/><resx path="strings/Labels.1033.resx" version="1.0.0"/></resources></control></manifest>',
  );
  await fs.writeFile(
    path.join(dir, 'ControlManifest.xml.data.xml'),
    '<CustomControl><Name>tst_Synthetic.Localized</Name></CustomControl>',
  );
  await fs.writeFile(
    path.join(dir, 'strings/Labels.1036.resx'),
    '<root><data name="Caption" xml:space="preserve"><value> Bonjour β </value></data><data name="Empty"><value></value></data></root>',
  );
  await fs.writeFile(
    path.join(dir, 'strings/Labels.1033.resx'),
    '<root><data name="Caption"><value>Hello</value></data><data name="EnglishOnly"><value>English-only value</value></data></root>',
  );
  await fs.writeFile(
    path.join(dir, 'bundle.js'),
    `ComponentFramework.registerControl('Synthetic.Localized', class {
    init(context, notify, state, container) { this.id=container.id; this.context=context; this.container=container; window.inits.push(this.id); }
    updateView(context) { this.context=context; const entry={lcid:context.userSettings.languageId,caption:context.resources.getString('Caption'),empty:context.resources.getString('Empty'),englishOnly:context.resources.getString('EnglishOnly'),unknown:context.resources.getString('Unknown'),displayName:context.parameters.value.attributes.DisplayName,raw:context.parameters.value.raw}; window.views[this.id]=entry; this.container.textContent=entry.caption; window.updates.push(this.id); }
    getOutputs() { return {value:this.context.parameters.value.raw}; }
    destroy() { window.destroyed.push(this.id); }
  });`,
  );
  const catalog = await importCodeComponents([{ dir: root }]);
  const cases = [
    { name: 'french', language: { code: 'fr-FR', lcid: 1036 } },
    { name: 'english', language: { code: 'en-US' } },
    { name: 'fallback', language: { code: 'de-DE', lcid: 1031 } },
    { name: 'unresolved', language: { code: 'ja-JP', lcid: 1041 }, noDefault: true },
  ];
  const diagnostics = [];
  const html =
    '<!doctype html><html><body><script>window.inits=[];window.views={};window.updates=[];window.destroyed=[];</script>' +
    cases
      .map(
        (c) =>
          `<section id="${c.name}">` +
          renderCodeComponent({
            name: 'tst_Synthetic.Localized',
            catalog,
            args: { value: 'Initial' },
            language: c.language,
            portal: { websiteLanguages: c.noDefault ? [] : [{ code: 'fr-FR', lcid: 1036, isDefault: true }] },
            diagnostic: (d) => diagnostics.push({ case: c.name, ...d }),
          }) +
          '</section>',
      )
      .join('') +
    '</body></html>';
  assert.deepEqual(
    diagnostics.map((d) => [d.case, d.code]),
    [
      ['fallback', 'PCF_RESOURCE_LANGUAGE_FALLBACK'],
      ['unresolved', 'PCF_RESOURCE_LANGUAGE_UNRESOLVED'],
    ],
  );
  const host = await fs.readFile(new URL('../lib/code-components-client.js', import.meta.url));
  const assets = new Map(
    await Promise.all([...catalog.assets].map(async ([url, asset]) => [url, await fs.readFile(asset.file)])),
  );
  const server = http.createServer((request, response) => {
    if (request.url === '/__sim-static/pcf-host.js') {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(host);
    } else if (assets.has(request.url)) {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(assets.get(request.url));
    } else {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(html);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [],
    external = [],
    origin = `http://127.0.0.1:${server.address().port}`;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith(origin + '/')) external.push(request.url());
  });
  await page.goto(origin, { timeout: 15000 });
  await page.waitForFunction(() => window.inits.length === 4 && Object.keys(window.views).length === 4);
  const state = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('section')].map((section) => {
        const component = section.querySelector('[data-pcf-schema]');
        return [section.id, { id: component.id, ...window.views[component.id] }];
      }),
    ),
  );
  assert.equal(state.french.caption, ' Bonjour β ');
  assert.equal(state.french.empty, '');
  assert.equal(state.french.displayName, '');
  assert.equal(state.french.englishOnly, 'EnglishOnly');
  assert.equal(state.english.caption, 'Hello');
  assert.equal(state.english.empty, 'Empty');
  assert.equal(state.english.englishOnly, 'English-only value');
  assert.equal(state.english.lcid, 1033);
  assert.equal(state.fallback.caption, ' Bonjour β ');
  assert.equal(state.fallback.lcid, 1031);
  assert.equal(state.unresolved.caption, 'Caption');
  assert.equal(state.unresolved.empty, 'Empty');
  assert.ok(Object.values(state).every((entry) => entry.unknown === 'Unknown'));
  assert.equal(new Set(Object.values(state).map((entry) => entry.id)).size, 4);
  const updated = await page.evaluate((id) => {
    window.__paqviloPcf.updateParameters(id, { value: 'Changed β' });
    return window.views[id];
  }, state.french.id);
  assert.equal(updated.raw, 'Changed β');
  assert.equal(updated.caption, ' Bonjour β ');
  assert.equal(updated.displayName, '');
  await page.locator('#french').evaluate((node) => node.remove());
  await page.waitForFunction((id) => window.destroyed.includes(id), state.french.id);
  assert.equal(
    await page.evaluate((id) => window.destroyed.filter((value) => value === id).length, state.french.id),
    1,
  );
  await page.locator('section').evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
  await page.waitForFunction(() => window.destroyed.length === 4);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});
