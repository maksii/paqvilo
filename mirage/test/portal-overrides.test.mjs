import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { applyPortalOverrides, validatePortalOverrides } from '../lib/portal-overrides.mjs';
import { signInHeaders } from '../testing/session.mjs';

export async function setupPortalOverrides(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-portal-overrides-'));
  let app;
  t.after(async () => { await app?.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const files = {
    'website.yml': 'adx_websiteid: site\nadx_name: Test',
    'web-pages/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'web-templates/Main.webtemplate.source.html': '<html><body><h1>{{ snippets.Greeting }}</h1><p>{{ settings.Theme }}</p></body></html>',
    'content-snippets/Greeting.contentsnippet.yml': 'adx_contentsnippetid: greeting\nadx_name: Greeting',
    'content-snippets/Greeting.contentsnippet.value.html': 'Source greeting',
    'sitesetting.yml': '- adx_name: Theme\n  adx_value: Source theme\n- adx_name: Webapi/item/enabled\n  adx_value: true\n- adx_name: Webapi/item/fields\n  adx_value: itemid,name',
    'web-roles/Reader.webrole.yml': 'adx_webroleid: reader\nadx_name: Reader\nadx_authenticatedusersrole: false',
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(directory, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content);
  }
  const stateFile = path.join(directory, 'state.json');
  const initial = {
    mappings: { item: { entitySet: 'items', idColumn: 'itemid' } },
    tables: { item: [{ itemid: 'one', name: 'Allowed' }] },
    permissions: [{ id: 'grant', entity: 'item', roles: ['Reader'], operations: ['read'], scope: 'global' }],
    simulator: { identity: { id: 'person', roles: ['Reader'] } },
  };
  app = await createSimulator({ sourceDir: directory, stateFile, watch: false, initial });
  return { get app() { return app; }, directory, stateFile, files, restart: async () => { await app.close(); app = await createSimulator({ sourceDir: directory, stateFile, watch: false }); return app; } };
}

test('portal overrides validate names/types and leave source immutable', () => {
  const source = { settings: { a: 'source' }, snippets: { hello: 'source' } };
  const result = applyPortalOverrides(source, { settings: { a: null }, snippets: { hello: 'edited' } });
  assert.equal(result.settings.a, undefined); assert.equal(result.snippets.hello, 'edited'); assert.equal(source.snippets.hello, 'source');
  for (const value of [[], { wrong: {} }, { settings: { a: 42 } }, { snippets: JSON.parse('{"__proto__":"bad"}') }]) assert.throws(() => validatePortalOverrides(value));
});

test('local web role changes control contact memberships and actual API read grants', async t => {
  const fixture = await setupPortalOverrides(t);
  const local = fixture.app.store.snapshot();
  local.mappings.contact = { entitySet: 'contacts', idColumn: 'contactid' };
  local.tables.contact = [{ contactid: 'person', fullname: 'Member' }];
  local.simulator.identity = { id: 'person', contactId: 'person', roles: [], roleSource: 'memberships' };
  local.simulator.contactRoles = [];
  await fixture.app.store.replaceState(local); await fixture.app.reload();
  // Portal API reads run as a browser session for the contact (its memberships decide).
  const reader = () => ({ headers: signInHeaders(fixture.app, 'person') });
  const request = async (value, method = 'PATCH') => {
    const state = await (await fetch(fixture.app.url + '/_sim/api/state?summary=1')).json();
    return fetch(fixture.app.url + '/_sim/api/portal-roles/reader', { method, headers: { 'content-type': 'application/json', 'x-sim-csrf': state.csrf }, ...(method === 'DELETE' ? {} : { body: JSON.stringify({ value }) }) });
  };
  assert.equal((await fetch(fixture.app.url + '/_api/items', reader())).status, 403);
  assert.equal((await request({ name: 'Reader', authenticatedUsersRole: true })).status, 200);
  assert.equal((await fetch(fixture.app.url + '/_api/items', reader())).status, 200);
  assert.equal((await fetch(fixture.app.url + '/_api/items?$select=name&$select=itemid', reader())).status, 400);
  assert.equal((await request(null)).status, 200);
  assert.equal((await fetch(fixture.app.url + '/_api/items', reader())).status, 403);
  assert.equal((await request(undefined, 'DELETE')).status, 200);
  assert.equal((await fetch(fixture.app.url + '/_api/items', reader())).status, 403);
  assert.equal(fixture.app.portal.records.find(row => row.id === 'reader').adx_authenticatedusersrole, false);
});

test('admin settings/snippets affect Liquid and API, persist/reload, reset to current source and require CSRF', async t => {
  const fixture = await setupPortalOverrides(t);
  const state = await (await fetch(fixture.app.url + '/_sim/api/state?summary=1')).json();
  assert.equal(state.config.portalSnippets[0].value, 'Source greeting');
  // Portal API reads run as a browser session with the Reader role (a session role override).
  const reader = () => ({ headers: signInHeaders(fixture.app, 'person', { roles: ['Reader'] }) });
  const mutate = async (kind, id, value, method = 'PATCH') => fetch(fixture.app.url + '/_sim/api/' + kind + '/' + encodeURIComponent(id), { method, headers: { 'content-type': 'application/json', 'x-sim-csrf': (await (await fetch(fixture.app.url + '/__sim/api/state?summary=1')).json()).csrf }, ...(method === 'DELETE' ? {} : { body: JSON.stringify({ value }) }) });
  assert.equal((await mutate('portal-settings', 'Theme', 42)).status, 400);
  assert.match(await (await fetch(fixture.app.url + '/')).text(), /Source greeting/);
  assert.equal((await fetch(fixture.app.url + '/_sim/api/portal-snippets/Greeting', { method: 'PATCH', body: '{"value":"bad"}' })).status, 403);
  assert.equal((await mutate('portal-snippets', 'Greeting', '{{ settings.Theme }} local')).status, 200);
  assert.equal((await mutate('portal-settings', 'Theme', 'Custom theme')).status, 200);
  assert.match(await (await fetch(fixture.app.url + '/')).text(), /Custom theme local/);
  assert.equal((await fetch(fixture.app.url + '/_api/items', reader())).status, 200);
  assert.equal((await mutate('portal-settings', 'Webapi/item/enabled', 'false')).status, 200);
  assert.equal((await fetch(fixture.app.url + '/_api/items', reader())).status, 404);
  await fixture.restart();
  assert.match(await (await fetch(fixture.app.url + '/')).text(), /Custom theme local/);
  await fs.writeFile(path.join(fixture.directory, 'content-snippets/Greeting.contentsnippet.value.html'), 'Fresh source');
  await fixture.app.reload();
  assert.match(await (await fetch(fixture.app.url + '/')).text(), /Custom theme local/);
  assert.equal((await mutate('portal-snippets', 'Greeting', undefined, 'DELETE')).status, 200);
  assert.match(await (await fetch(fixture.app.url + '/')).text(), /Fresh source/);
  assert.equal((await mutate('portal-settings', 'Theme', null)).status, 200);
  assert.equal(fixture.app.portal.settings.Theme, undefined);
  assert.equal(await fs.readFile(path.join(fixture.directory, 'sitesetting.yml'), 'utf8'), fixture.files['sitesetting.yml']);
});
