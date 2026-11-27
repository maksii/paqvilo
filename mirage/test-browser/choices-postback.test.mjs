// @test-kind observation: hosted F2 session (paqvilo-developer hosted-f2, runs a and b agree, group choices): the choices control's hidden input holds the JSON array of the selected options' metadata with every language label (1033 and 1031), and the basic form saves the posted selection; `[]` clears the column
// Invented schema and loopback fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const OPTIONS = [
  { value: 100000000, label: 'Amber', labels: { 1031: 'Bernstein', 1033: 'Amber' } },
  { value: 100000001, label: 'Cobalt', labels: { 1031: 'Kobalt', 1033: 'Cobalt' } },
  { value: 100000002, label: 'Moss', labels: { 1031: 'Moos', 1033: 'Moss' } },
];

test('the choices control posts its JSON selection and the form saves the option values', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'choices-postback-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_websiteid: choices-site\nadx_name: Choices fixture',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '{% entityform name: "Gadget" %}',
    'Gadget.basicform.yml':
      'adx_entityformid: gadget\nadx_name: Gadget\nadx_entityname: gadget\nadx_mode: 100000001\nadx_recordidquerystringparametername: id\nadx_hideformonsuccess: false',
    'sitesetting.yml': '- adx_name: Site/BootstrapV5Enabled\n  adx_value: "true"',
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(root, name), content);
  const app = await createSimulator({
    sourceDir: root,
    port: 0,
    watch: false,
    initial: {
      mappings: {
        gadget: {
          entitySet: 'gadgets',
          idColumn: 'gadgetid',
          fields: {
            label: { dataverseType: 'nvarchar' },
            hues: { dataverseType: 'multiselectpicklist', options: OPTIONS },
          },
        },
      },
      tables: { gadget: [{ gadgetid: 'gadget-1', label: 'Stored', hues: '100000001' }] },
      settings: { permissionMode: 'permissive' },
      simulator: {
        componentSchemas: {
          gadget: {
            entity: 'gadget',
            fields: [
              { name: 'label', type: 'text', label: 'Label', dataverseType: 'nvarchar' },
              { name: 'hues', label: 'Hues', dataverseType: 'multiselectpicklist', options: OPTIONS },
            ],
          },
        },
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const stored = () => app.store.tableRows('gadget')[0].hues;
  const hidden = async () => JSON.parse(await page.locator('#hues').getAttribute('value'));
  const submit = async () => {
    await Promise.all([page.waitForNavigation(), page.locator('#UpdateButton').click()]);
  };

  await page.goto(app.url + '/?id=gadget-1');
  // The control expands the stored value to the selected option's metadata, every language label included.
  await page.waitForFunction(() => document.getElementById('hues')?.getAttribute('value')?.includes('LocalizedLabels'));
  const [selected] = await hidden();
  assert.equal(selected.Value, 100000001);
  assert.deepEqual(
    selected.Label.LocalizedLabels.map((label) => [label.LanguageCode, label.Label]),
    [
      [1033, 'Cobalt'],
      [1031, 'Kobalt'],
    ],
  );
  // An unchanged save posts that metadata back and keeps the stored option.
  await submit();
  assert.equal(stored(), '100000001');

  // The selection the control writes: two options, then none.
  for (const [value, expected] of [
    ['[{"Value":100000000},{"Value":100000002}]', '100000000,100000002'],
    ['[]', null],
  ]) {
    await page.locator('#hues').evaluate((node, text) => node.setAttribute('value', text), value);
    await submit();
    assert.equal(stored(), expected);
  }
  assert.deepEqual(errors, []);
});
