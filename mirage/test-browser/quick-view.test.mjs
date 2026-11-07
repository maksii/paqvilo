import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const website = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const parent = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('lookup changes reload quick views, clearing blanks them, and quick documents share modal styles', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-quick-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries({
    'website.yml': `adx_websiteid: ${website}\nadx_name: Synthetic`,
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml':
      'adx_pagetemplateid: template\nadx_name: Main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '{% entityform name: "Create widget" %}',
    'Widget.basicform.basicformmetadata.yml':
      'adx_entityform: create\nadx_type: 100000000\nadx_attributelogicalname: email\nadx_controlstyle: 756150001',
    'Site.webfile.yml':
      'adx_webfileid: style\nadx_name: site.css\nadx_partialurl: site.css\nadx_parentpageid: home\nadx_mimetype: text/css',
    'site.css': '.crmEntityFormView .info{color:rgb(1,2,3)}',
    'local.css': ':root{--local-only-flag:1}',
    'Widget.basicform.yml':
      'adx_entityformid: create\nadx_name: Create widget\nadx_entityname: widget\nadx_mode: 100000000',
  }))
    await fs.writeFile(path.join(root, file), source);
  const fields = [
    { name: 'name', label: 'Name' },
    { name: 'parentid', label: 'Parent', type: 'lookup', targets: ['parent'] },
    { name: 'email', label: 'Email', type: 'email' },
  ];
  const schema = {
    entity: 'widget',
    mode: 100000000,
    fields,
    layout: [
      {
        name: 'tab',
        columns: [
          {
            sections: [
              {
                name: 'main',
                rows: [
                  [{ name: 'name' }],
                  [{ name: 'parentid' }],
                  [{ name: 'email' }],
                  [
                    {
                      type: 'quickform',
                      id: 'ParentDetails',
                      lookup: 'parentid',
                      entity: 'parent',
                      schema: { formName: 'Parent details', fields: [{ name: 'name', label: 'Parent name' }] },
                    },
                  ],
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const initial = {
    mappings: {
      widget: {
        idColumn: 'widgetid',
        entitySet: 'widgets',
        relationships: { parent: { entity: 'parent', from: 'parentid', to: 'parentid', many: false } },
      },
      parent: { idColumn: 'parentid', entitySet: 'parents', nameColumn: 'name' },
    },
    tables: { widget: [], parent: [{ parentid: parent, name: 'Synthetic parent' }] },
    permissions: [],
    settings: { permissionMode: 'permissive' },
    simulator: {
      componentSchemas: { create: schema },
      endpoints: [],
      mode: 'local',
      pageMode: 'local',
      live: { origin: null },
    },
  };
  const app = await createSimulator({
    sourceDir: root,
    initial,
    watch: false,
    projectRoot: root,
    head: { stylesheets: ['./local.css'] },
  });
  ownedFixture(t).add(() => app.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const page = await browser.newPage();
  await page.goto(app.url);
  assert.equal(await page.locator('#ParentDetails').getAttribute('src'), 'about:blank');
  assert.equal(await page.locator('#email[type=email]').count(), 1);
  assert.equal(await page.locator('[data-mirage-component=codecomponent]').count(), 0);
  const status = await (await fetch(app.url + '/_sim/api/status')).json();
  assert.ok(status.diagnostics.byCode.PCF_NATIVE_BINDING_UNSUPPORTED);
  await page.locator('.launchentitylookup').click();
  await page.locator('#parentid_lookupmodal tr[data-id="' + parent + '"]').click();
  await page.locator('#parentid_lookupmodal').getByRole('button', { name: 'Select', exact: true }).click();
  const frame = page.frameLocator('#ParentDetails');
  await frame.locator('#name').waitFor();
  assert.equal(await frame.locator('#name').inputValue(), 'Synthetic parent');
  await page.evaluate(() => {
    document.getElementById('parentid').value = '';
    window.jQuery('#parentid').trigger('change');
  });
  await page.waitForFunction(() => document.getElementById('ParentDetails').getAttribute('src') === 'about:blank');
  assert.equal(await page.locator('#ParentDetails').getAttribute('tabindex'), '-1');
  await page.evaluate((id) => {
    document.getElementById('parentid').value = id;
    window.jQuery('#parentid').trigger('change');
  }, parent);
  await frame.locator('#name').waitFor();
  assert.equal(await page.locator('#ParentDetails').getAttribute('tabindex'), '0');
  const geometry = await frame.locator('#name').evaluate((input) => ({
    input: input.getBoundingClientRect().width,
    control: input.parentElement.getBoundingClientRect().width,
    height: input.getBoundingClientRect().height,
  }));
  assert.ok(Math.abs(geometry.input - geometry.control) < 1, JSON.stringify(geometry));
  assert.ok(geometry.height >= 34);
  const quick = new URL(await page.locator('#ParentDetails').getAttribute('src'), app.url);
  assert.equal(quick.searchParams.get('entityprimarykeyname'), 'parentid');
  // The server-rendered URL of a bound frame is answered only after the client had the chance to
  // replace it (live: that first navigation is abandoned); the client's own URL answers at once.
  const held = new URL(quick);
  held.searchParams.set('isprofilepage', 'false');
  held.searchParams.set('lang', 'en-US');
  await assert.rejects(fetch(held, { signal: AbortSignal.timeout(500) }), (error) => error.name === 'TimeoutError');
  const stylesheetPaths = (html) => [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((match) => match[1]);
  for (const captured of [false, true]) {
    if (captured) {
      const state = app.store.snapshot();
      state.simulator.shellProfile = {
        stylesheets: ['/site.css', '/captured.css'],
        platformStyles: { mode: 'captured', origin: 'https://synthetic.example.test', capturedAt: '2026-10-12' },
      };
      await app.store.replaceState(state);
    }
    const quickHtml = await (await fetch(quick)).text();
    const modalHtml = await (
      await fetch(`${app.url}/_portal/modal-form-template-path/${website}?entityformid=create`)
    ).text();
    assert.deepEqual(stylesheetPaths(quickHtml), stylesheetPaths(modalHtml));
    assert.equal(stylesheetPaths(quickHtml).filter((href) => href.split('?')[0] === '/site.css').length, 1);
    assert.ok(stylesheetPaths(quickHtml).some((href) => href.startsWith('/_sim-local/head/')));
    assert.match(quickHtml, /id="content-container" class="container quickform"/);
    assert.match(modalHtml, /id="content-container" class="container wrapper-body"/);
    // Both documents use the layout master frame outside the site map: language attributes,
    // the home page title, layout body attributes, the offline bar and the portal-scoped holder.
    for (const html of [quickHtml, modalHtml]) {
      assert.match(html, /<html lang="en-US" dir="ltr" crm-lang="en-US" crm-lcid="1033"/);
      assert.match(html, /<title>Home<\/title>/);
      assert.match(html, /<body data-sitemap-state="\/" data-dateformat=/);
      assert.match(html, /<div id="offlineNotificationBar" class="displayNone">/);
      assert.match(
        html,
        new RegExp(`<div id="antiforgerytoken" data-url="/_portal/${website}/Layout/GetAntiForgeryToken"></div>`),
      );
      assert.match(html, /<div id="pp-native-controls-react-root"><\/div>/);
    }
    assert.match(
      quickHtml,
      /<form method="post" action="\.\/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\?[^"]*" onsubmit="javascript:return WebForm_OnSubmit\(\);" id="content_form">/,
    );
    assert.match(
      quickHtml,
      /<div id="ContentContainer_FormPanel"><div id="ParentDetails" class="form-readonly entity-form crmEntityFormView" readonly="readonly"><input type="hidden" name="ctl00\$ContentContainer\$ParentDetails\$ParentDetails_EntityName"/,
    );
    assert.match(
      quickHtml,
      /<input name="ctl00\$ContentContainer\$ParentDetails\$name" type="text" value="Synthetic parent" id="name"/,
    );
  }
});
