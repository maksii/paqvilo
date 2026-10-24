import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

test('native checkbox saves typed values visible to Web API, FetchXML and Liquid', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'checkbox-postback-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_websiteid: checkbox-site\nadx_name: Checkbox fixture',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html':
      '{% entityform name: "Entry" %}{% fetchxml flags %}<fetch><entity name="sample"><attribute name="enabled"/><filter><condition attribute="enabled" operator="eq" value="1"/></filter></entity></fetch>{% endfetchxml %}<div id="boolean-result">{% for row in flags.results.entities %}{% if row.enabled %}Enabled{% endif %}{% endfor %}</div>',
    'Entry.basicform.yml':
      'adx_entityformid: entry\nadx_name: Entry\nadx_entityname: sample\nadx_mode: 100000001\nadx_entitysourcetype: 756150001\nadx_recordidquerystringparametername: id\nadx_hideformonsuccess: false',
    'sitesetting.yml':
      '- adx_name: Webapi/sample/enabled\n  adx_value: true\n- adx_name: Webapi/sample/fields\n  adx_value: enabled,locked',
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(root, name), content);
  const id = '10000000-0000-4000-8000-000000000001',
    fields = [
      { name: 'enabled', type: 'boolean' },
      { name: 'locked', type: 'boolean', readOnly: true },
    ];
  const app = await createSimulator({
    sourceDir: root,
    port: 0,
    watch: false,
    initial: {
      mappings: {
        sample: {
          entitySet: 'samples',
          idColumn: 'sampleid',
          fields: Object.fromEntries(fields.map((f) => [f.name, { type: 'bit' }])),
        },
      },
      tables: { sample: [{ sampleid: id, enabled: false, locked: true }] },
      permissions: [{ entity: 'sample', scope: 'global', roles: ['Editor'], operations: ['read', 'update'] }],
      settings: { permissionMode: 'enforce' },
      simulator: { componentSchemas: { entry: { entity: 'sample', fields } } },
    },
  });
  ownedFixture(t).add(() => app.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const context = await browser.newContext();
  await signInContext(context, app, 'editor', { roles: ['Editor'] });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const check = async (expected) => {
    const response = await context.request.get(app.url + `/_api/samples(${id})?$select=enabled,locked`);
    assert.equal(response.status(), 200);
    const row = await response.json();
    assert.equal(row.enabled, expected);
    assert.equal(row.locked, true);
    assert.equal((await page.locator('#boolean-result').innerText()).trim(), expected ? 'Enabled' : '');
  };
  await page.goto(app.url + '/?id=' + id);
  await check(false);
  for (const [value, expected] of [
    ['on', true],
    [null, false],
    ['custom', true],
  ]) {
    await page.locator('#enabled').evaluate((node, value) => {
      node.checked = value !== null;
      if (value !== null) node.value = value;
    }, value);
    await Promise.all([page.waitForNavigation(), page.locator('#UpdateButton').click()]);
    await check(expected);
  }
  assert.deepEqual(errors, []);
});
