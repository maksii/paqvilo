import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

test('exported native state-action buttons send configured actions without submitting editable values', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-state-actions-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const actions = [{ Type: 'DeactivateAction', ButtonLabel: [{ LCID: 1033, Value: 'Close entry' }] }, { Type: 'ActivateAction', ButtonLabel: [{ LCID: 1033, Value: 'Reopen entry' }] }];
  const files = {
    'website.yml': 'adx_websiteid: state-site\nadx_name: State fixture',
    'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '{% entityform name: "Entry" %}{% entityform name: "Second entry" %}',
    'Entry.basicform.yml': `adx_entityformid: entry-form\nadx_name: Entry\nadx_entityname: sample\nadx_mode: 100000001\nadx_entitysourcetype: 756150001\nadx_recordidquerystringparametername: row\nadx_settings: ${JSON.stringify(JSON.stringify({ Actions: actions }))}`,
    'Second.basicform.yml': `adx_entityformid: second-form\nadx_name: Second entry\nadx_entityname: sample\nadx_mode: 100000001\nadx_settings: ${JSON.stringify(JSON.stringify({ Actions: actions }))}`,
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(root, name), content);
  const id = '00000000-0000-4000-8000-000000000001';
  const secondId = '00000000-0000-4000-8000-000000000002';
  const formFields = [{ name: 'title', label: 'Title', type: 'text', required: true }];
  const app = await createSimulator({ sourceDir: root, watch: false, initial: {
    mappings: { sample: { entitySet: 'samples', idColumn: 'sampleid', nameColumn: 'title', fieldMetadata: {
      title: { dataverseType: 'nvarchar' },
      statecode: { dataverseType: 'state', states: [{ value: 0, defaultStatus: 100 }, { value: 1, defaultStatus: 300 }] },
      statuscode: { dataverseType: 'status', statuses: [{ value: 100, state: 0 }, { value: 300, state: 1 }, { value: 301, state: 1 }] },
    } } },
    tables: { sample: [{ sampleid: id, title: 'Original', statecode: 0, statuscode: 100 }, { sampleid: secondId, title: 'Second', statecode: 0, statuscode: 100 }] },
    permissions: [{ entity: 'sample', scope: 'global', roles: ['Editor'], operations: ['read', 'update'] }],
    settings: { permissionMode: 'enforce', 'Webapi/sample/enabled': false },
    simulator: { observed: { nativeFormTransport: 'json', evidence: 'Invented loopback JSON transport fixture' }, componentSchemas: { 'entry-form': { entity: 'sample', fields: formFields }, 'second-form': { entity: 'sample', recordId: secondId, fields: formFields } } },
  } });
  ownedFixture(t).add(() => app.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const context = await browser.newContext();
  await signInContext(context, app, 'editor', { roles: ['Editor'] });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${app.url}/?row=${id}`);
  const first = page.locator('#EntityFormControl_entryform'), second = page.locator('#EntityFormControl_secondform');
  assert.equal(await page.locator('#UpdateButton').count(), 0, 'an action-only export must not get an invented Submit button');
  await first.locator('#title').fill('');
  await first.locator('#title').press('Tab');
  // entityform.js action bar (live markup): button.deactivate-link / button.activate-link post the
  // record reference as JSON to /_services/action-*/{website} and reload; the inapplicable state
  // button is hidden. Editable values are never part of the post.
  const action = (name) => page.waitForResponse((response) => response.url().includes('/_services/action-' + name + '/') && response.request().method() === 'POST');
  assert.equal(await first.locator('button.activate-link.hidden').count(), 1, 'the inapplicable state action is hidden');
  const closeResponse = action('deactivate');
  const closeReload = page.waitForEvent('load');
  await first.locator('button.deactivate-link').click();
  assert.deepEqual(errors, [], 'native action handler must execute');
  const closed = await closeResponse;
  assert.equal(closed.status(), 204);
  assert.deepEqual(closed.request().postDataJSON(), { entityReference: { LogicalName: 'sample', Id: id } });
  await closeReload;
  await first.locator('button.activate-link:not(.hidden)').waitFor();
  let record = await app.store.get('sample', id, { roles: ['Editor'] });
  assert.deepEqual([record.title, record.statecode, record.statuscode], ['Original', 1, 300]);
  assert.equal(await first.locator('#DeactivateButton').count(), 0);
  assert.equal(await first.locator('button.deactivate-link.hidden').count(), 1);
  const reopenResponse = action('activate');
  const reopenReload = page.waitForEvent('load');
  await first.locator('button.activate-link').click();
  assert.equal((await reopenResponse).status(), 204);
  await reopenReload;
  await first.locator('button.deactivate-link:not(.hidden)').waitFor();
  record = await app.store.get('sample', id, { roles: ['Editor'] });
  assert.deepEqual([record.title, record.statecode, record.statuscode], ['Original', 0, 100]);
  const secondResponse = action('deactivate');
  const secondReload = page.waitForEvent('load');
  await second.locator('button.deactivate-link').click();
  const secondSaved = await secondResponse;
  assert.equal(secondSaved.status(), 204);
  assert.equal(secondSaved.request().postDataJSON().entityReference.Id, secondId, 'duplicate button classes retain their owning native form');
  await secondReload;
  await second.locator('button.activate-link:not(.hidden)').waitFor();
  assert.equal((await app.store.get('sample', id, { roles: ['Editor'] })).statecode, 0);
  assert.equal((await app.store.get('sample', secondId, { roles: ['Editor'] })).statecode, 1);
  assert.deepEqual(errors, []);
});
