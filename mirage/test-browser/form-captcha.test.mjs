// @test-kind security: the trusted local CAPTCHA fixture (a registered serviceFixtures.captcha pack) gates a basic form and the same form opened as a modal form in a real browser: the rendered challenge is answered in the page, a wrong answer is refused with the platform's message and saves nothing, and the fixture answer of a fresh challenge saves; invented schema, loopback fixture
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { ownedClose, makeTemporaryDirectory, removeFixtureDirectory, ownedFixture } from '../testing/owned-fixture.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

const PROMPT = 'What is 2 + 3?';
const REFUSED = 'Captcha is incorrect, please re-enter captcha.';

async function site(t, transport) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-form-captcha-'));
  ownedFixture(t).remove(() => removeFixtureDirectory(root));
  const files = {
    'website.yml': 'adx_websiteid: captcha-site\nadx_name: Invented captcha site',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml':
      'adx_pagetemplateid: template\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '{% entityform name: "Create sample" %}',
    'Create.basicform.yml': [
      'adx_entityformid: create-sample',
      'adx_name: Create sample',
      'adx_entityname: sample',
      'adx_mode: 100000000',
      'adx_captcharequired: true',
      'adx_showcaptchaforauthenticatedusers: false',
      'adx_successmessage: Sample saved',
      'adx_hideformonsuccess: false',
    ].join('\n'),
  };
  await Promise.all(Object.entries(files).map(([name, source]) => fs.writeFile(path.join(root, name), source)));
  const app = await createSimulator({
    sourceDir: root,
    watch: false,
    packs: [
      {
        id: 'test-captcha',
        name: 'Invented CAPTCHA fixture',
        description: 'Loopback form fixture',
        matches: () => true,
        presets: () => ({}),
        serviceFixtures: { captcha: { challenge: () => ({ prompt: PROMPT, answer: '5' }) } },
      },
    ],
    initial: {
      mappings: {
        sample: { entitySet: 'samples', idColumn: 'sampleid', fields: { title: { dataverseType: 'nvarchar' } } },
      },
      tables: { sample: [] },
      settings: { permissionMode: 'permissive' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        identity: { roles: [] },
        live: {},
        endpoints: [],
        observed: { nativeFormTransport: transport, evidence: 'Invented loopback captcha fixture' },
        componentSchemas: {
          'create-sample': {
            entity: 'sample',
            fields: [{ name: 'title', type: 'text', label: 'Title', required: true }],
          },
        },
      },
    },
  });
  ownedClose(t, app);
  const context = await browser.newContext();
  ownedFixture(t).add(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { app, page, errors };
}

const challengeOf = (page) => page.locator('[data-pp-captcha-challenge]').inputValue();
const titles = (app) => app.store.snapshot().tables.sample.map((row) => row.title);

async function answerAndSubmit(page, title, answer) {
  await page.locator('#title').fill(title);
  await page.getByLabel(PROMPT).fill(answer);
  await page.locator('#InsertButton').click();
}

async function assertChallengeFlow(app, page, url) {
  await page.goto(url);
  await page.getByLabel(PROMPT).waitFor();
  const first = await challengeOf(page);
  await answerAndSubmit(page, 'Wrong answer', '4');
  await page.getByText(REFUSED).first().waitFor();
  assert.deepEqual(titles(app), []);
  // The refusal renders a fresh challenge; the spent one is not offered again.
  await page.getByLabel(PROMPT).waitFor();
  const second = await challengeOf(page);
  assert.notEqual(second, first);
  await answerAndSubmit(page, 'Right answer', '5');
  await page.getByText('Sample saved').waitFor();
  assert.deepEqual(titles(app), ['Right answer']);
}

for (const transport of ['postback', 'json']) {
  test(`a basic form with CAPTCHA renders the local challenge, refuses a wrong answer and saves with the fixture answer (${transport})`, async (t) => {
    const { app, page, errors } = await site(t, transport);
    await assertChallengeFlow(app, page, app.url + '/');
    assert.deepEqual(errors, []);
  });

  test(`the same form as a modal form renders and enforces the local challenge (${transport})`, async (t) => {
    const { app, page, errors } = await site(t, transport);
    await assertChallengeFlow(
      app,
      page,
      `${app.url}/_portal/modal-form-template-path/captcha-site?entityformid=create-sample`,
    );
    assert.deepEqual(errors, []);
  });
}
