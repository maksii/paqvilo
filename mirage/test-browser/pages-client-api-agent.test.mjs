// @test-kind observation: hosted session F3 (paqvilo-developer hosted-f3 summary-F3.md API-05b, agent-probe captures of runs a and b): in the browser $pages.agent.SendActivity reads the site's agent configuration and fails with the captured invalid-agent text when it lists none; a listed agent requests a Direct Line token and fails with the captured connection text when none is issued
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../api.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

const SITE = '77777777-7777-4777-8777-777777777e10';

async function agentPage(t, endpoints) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pages-agent-browser-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented agent`,
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '<main id="agent">agent</main>',
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const sim = await createSimulator({
    sourceDir: dir,
    port: 0,
    watch: false,
    initial: {
      version: 1,
      settings: { permissionMode: 'enforce' },
      simulator: { mode: 'local', pageMode: 'local', permissionSource: 'configured', endpoints },
    },
  });
  ownedFixture(t).add(() => sim.close());
  const context = await browser.newContext();
  ownedFixture(t).add(() => context.close());
  const page = await context.newPage();
  const requests = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  await page.goto(`${sim.url}/`);
  const send = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          window.Microsoft.PowerPages.onPagesClientApiReady().then(($pages) =>
            $pages.agent.SendActivity(
              'x_agent',
              { type: 'message', text: 'hello' },
              (reply) => resolve({ reply }),
              (error) => resolve({ error: error.message }),
            ),
          ),
        ),
    );
  return { send, requests };
}

test('SendActivity answers the captured texts over the hosted route sequence', async (t) => {
  const unlisted = await agentPage(t, []);
  assert.deepEqual(await unlisted.send(), {
    error: 'Invalid bot schema name or access denied. Please check the bot schema name and try again',
  });
  assert.ok(unlisted.requests.includes('/_services/agent/BotConfiguration'));
  assert.ok(!unlisted.requests.includes('/_services/auth/portalusertoken'));

  const listed = await agentPage(t, [
    {
      id: 'agent-configuration',
      path: '/_services/agent/BotConfiguration',
      method: 'GET',
      mode: 'mock',
      body: [{ name: 'Invented agent', botSchemaName: 'x_agent', isVisible: true }],
    },
  ]);
  assert.deepEqual(await listed.send(), {
    error: 'Something went wrong while creating direct line connection: Please try again',
  });
  for (const route of ['/_services/auth/portalusertoken', '/powervirtualagents/botsbyschema/x_agent/directline/token'])
    assert.ok(listed.requests.includes(route), route);
});

// @test-kind contract: the local Copilot stand-in: endpoint mocks for the Direct Line token and the conversation's activities deliver the reply to the response callback
test('SendActivity delivers a local stand-in reply', async (t) => {
  const reply = { type: 'message', text: 'Invented reply' };
  const { send } = await agentPage(t, [
    {
      id: 'agent-configuration',
      path: '/_services/agent/BotConfiguration',
      method: 'GET',
      mode: 'mock',
      body: [{ botSchemaName: 'x_agent' }],
    },
    {
      id: 'agent-token',
      path: '/powervirtualagents/botsbyschema/x_agent/directline/token',
      method: 'GET',
      mode: 'mock',
      body: { token: 'local', conversationId: 'conversation-1' },
    },
    {
      id: 'agent-activities',
      path: '/v3/directline/conversations/conversation-1/activities',
      method: 'POST',
      mode: 'mock',
      body: reply,
    },
  ]);
  assert.deepEqual(await send(), { reply });
});
