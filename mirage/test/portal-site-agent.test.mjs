// @test-kind observation: hosted session F3 (paqvilo-developer hosted-f3 summary-F3.md API-05b, agent-probe captures of runs a and b, anonymous and signed-in, 2026-11-27): /_services/agent/BotConfiguration answers [] for a visitor without a Bot Consumer web role, /_services/auth/portalusertoken answers 200 application/jwt, and POST /_api/agents/<schema>/activities answers 400 9004010A in every state
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { signInHeaders } from '../testing.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const SITE = '77777777-7777-4777-8777-777777777d10';
const CONTACT = '77777777-7777-4777-8777-777777777d11';

async function agentSite(t, endpoints = []) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-site-agent-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented agent`,
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '<main>agent</main>',
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const sim = await createSimulator({
    sourceDir: dir,
    port: 0,
    watch: false,
    initial: {
      version: 1,
      tables: { contact: [{ contactid: CONTACT, fullname: 'Invented contact' }] },
      settings: { permissionMode: 'enforce' },
      simulator: { mode: 'local', permissionSource: 'configured', endpoints },
    },
  });
  ownedFixture(t).add(() => sim.close());
  const token = /value="([^"]+)"/.exec(await (await fetch(`${sim.url}/_layout/tokenhtml`)).text())[1];
  const call = (method, target, { headers = {}, body } = {}) =>
    fetch(sim.url + target, {
      method,
      body,
      headers: {
        origin: sim.url,
        'x-requested-with': 'XMLHttpRequest',
        __requestverificationtoken: token,
        'content-type': 'application/json',
        ...headers,
      },
    });
  return { sim, call };
}

test('the site agent routes answer the captured shapes', async (t) => {
  const { sim, call } = await agentSite(t);
  for (const headers of [{}, signInHeaders(sim, CONTACT)]) {
    const configuration = await call('GET', '/_services/agent/BotConfiguration', { headers });
    assert.equal(configuration.status, 200);
    assert.match(configuration.headers.get('content-type'), /^application\/json; charset=utf-8/);
    assert.deepEqual(await configuration.json(), []);
    const userToken = await call('POST', '/_services/auth/portalusertoken', { headers });
    assert.equal(userToken.status, 200);
    assert.equal(userToken.headers.get('content-type'), 'application/jwt; charset=utf-8');
    assert.match(await userToken.text(), /^[\w-]+\.[\w-]+\.[\w-]+$/);
    const activities = await call('POST', '/_api/agents/x_agent/activities', {
      headers,
      body: JSON.stringify({ type: 'message', text: 'hello' }),
    });
    assert.equal(activities.status, 400);
    assert.deepEqual(await activities.json(), {
      error: { code: '9004010A', message: 'An unexpected error occurred while processing the request' },
    });
  }
});

// @test-kind contract: a project endpoint mock supplies the agent configuration Mirage does not hold (Copilot Studio values are not in the export)
test('an endpoint mock supplies the site agent configuration', async (t) => {
  const listed = [{ name: 'Invented agent', botSchemaName: 'x_agent', isVisible: true }];
  const { call } = await agentSite(t, [
    { id: 'agent', path: '/_services/agent/BotConfiguration', method: 'GET', mode: 'mock', body: listed },
  ]);
  assert.deepEqual(await (await call('GET', '/_services/agent/BotConfiguration')).json(), listed);
});
