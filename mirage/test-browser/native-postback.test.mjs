import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

test('postback mode submits actual URLencoded successful controls and navigates to escaped source HTML', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'native-browser-postback-'));
  const files = {
    'website.yml': 'adx_websiteid: browser-site\nadx_name: Invented postback',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml':
      'adx_pagetemplateid: template\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html':
      '<!doctype html><html><body><script>window.__typedProbe=0</script><form id="liquid_form">{% entityform name: "First" %}{% entityform name: "Second" %}</form></body></html>',
    'First.basicform.yml':
      'adx_entityformid: first\nadx_name: First\nadx_mode: 100000001\nadx_recordidquerystringparametername: firstrow',
    'Second.basicform.yml':
      'adx_entityformid: second\nadx_name: Second\nadx_mode: 100000001\nadx_recordidquerystringparametername: secondrow\nadx_successmessage: Browser saved\nadx_hideformonsuccess: false',
  };
  for (const [name, source] of Object.entries(files)) await fs.writeFile(path.join(root, name), source);
  const fields = [
    { name: 'title', label: 'Title', type: 'text', required: true },
    { name: 'description', type: 'textarea' },
    { name: 'count', dataverseType: 'int', minimum: 0, maximum: 10 },
  ];
  const app = await createSimulator({
    sourceDir: root,
    watch: false,
    initial: {
      mappings: {
        sample: {
          entitySet: 'samples',
          idColumn: 'sampleid',
          fields: {
            title: { dataverseType: 'nvarchar' },
            description: { dataverseType: 'memo' },
            count: { dataverseType: 'int' },
          },
        },
      },
      tables: {
        sample: [
          { sampleid: 'first-row', title: 'First' },
          { sampleid: 'second-row', title: 'Second' },
        ],
      },
      settings: { permissionMode: 'permissive' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        identity: { roles: [] },
        live: {},
        endpoints: [],
        observed: { nativeFormTransport: 'postback', evidence: 'Invented loopback browser transport' },
        componentSchemas: { first: { entity: 'sample', fields }, second: { entity: 'sample', fields } },
      },
    },
  });
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(async () => {
    await browser.close();
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const page = await browser.newPage(),
    errors = [],
    requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST') requests.push(request);
  });
  const route = '/?firstrow=first-row&secondrow=second-row';
  await page.goto(app.url + route);
  const first = page.locator('#EntityFormControl_first'),
    second = page.locator('#EntityFormControl_second');
  await first.locator('#title').fill('Unselected first');
  const markup = '<img src=x onerror="window.__typedProbe=1"><script>window.__typedProbe=2</script>';
  await second.locator('#title').fill(markup);
  await second.locator('#description').fill('First\nSecond');
  await second.locator('#count').fill('4');
  const response = page.waitForResponse(
    (item) => item.request().isNavigationRequest() && item.request().method() === 'POST',
  );
  await second.locator('#UpdateButton').click();
  assert.equal((await response).status(), 200);
  await second.locator('#MessageLabel').waitFor();
  assert.equal(await second.locator('#MessageLabel').innerText(), 'Browser saved');
  assert.equal(await second.locator('#title').inputValue(), markup);
  assert.equal(await first.locator('#title').inputValue(), 'First');
  assert.equal(await page.evaluate(() => window.__typedProbe), 0);
  assert.equal(requests.length, 1);
  const request = requests[0],
    posted = new URLSearchParams(request.postData());
  assert.equal(request.url(), app.url + route);
  assert.match(request.headers()['content-type'], /^application\/x-www-form-urlencoded/);
  assert.equal(posted.get('__EVENTTARGET'), 'ctl00$ContentContainer$EntityFormControl_second$UpdateButton');
  assert.equal(
    posted.get('ctl00$ContentContainer$EntityFormControl_second$EntityFormControl_second_EntityFormView$title'),
    markup,
  );
  assert.deepEqual(
    app.store.snapshot().tables.sample.map((row) => row.title),
    ['First', markup],
  );
  assert.equal(app.store.snapshot().tables.sample[1].count, 4);
  assert.deepEqual(errors, []);
});
