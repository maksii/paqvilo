// @test-kind contract+security: invented loopback modal shell opt-in preserves signed-in session, form permissions and route boundaries.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { ownedClose, makeTemporaryDirectory, removeFixtureDirectory, ownedFixture } from '../testing/owned-fixture.mjs';
import { signInContext, signInHeaders } from '../testing/session.mjs';

const zeroWebsite = '00000000-0000-0000-0000-000000000000';
const modalRoot = '/_portal/modal-form-template-path';
const modalPath = `${modalRoot}/${zeroWebsite}/`;
const shellPath = `${modalPath}?purpose=compare`;
const formQuery = 'id=widget&entityformid=edit-widget';
const files = {
  'website.yml': 'adx_websiteid: widget-site\nadx_name: Widget site',
  'Home.webpage.yml':
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: tools',
  'Tools.pagetemplate.yml':
    'adx_pagetemplateid: tools\nadx_name: Tools\nadx_webtemplateid: tools-template\nadx_usewebsiteheaderandfooter: true',
  'Tools.webtemplate.yml': 'adx_webtemplateid: tools-template\nadx_name: Tools',
  'Tools.webtemplate.source.html': `<button type="button" id="compare-widgets">Compare widgets</button>
<script>
document.getElementById('compare-widgets').addEventListener('click', () => {
  const frame = document.createElement('iframe');
  frame.id = 'compare';
  frame.onload = () => {
    const doc = frame.contentDocument;
    const content = doc.querySelector('#content-container');
    if (!content) return;
    const mode = doc.createElement('select');
    mode.id = 'mode';
    mode.add(new Option('Compare by name', 'name'));
    content.append(mode);
  };
  frame.src = '${shellPath}';
  document.body.append(frame);
});
</script>`,
  'PortalUser.contentsnippet.yml': 'adx_contentsnippetid: portal-user\nadx_name: Head/Bottom',
  'PortalUser.contentsnippet.value.html': '<meta name="portal-user" content="{{ user.fullname | escape }}">',
  'Private.webpage.yml':
    'adx_webpageid: private\nadx_name: Private\nadx_partialurl: private\nadx_parentpageid: home\nadx_pagetemplateid: tools',
  'Private.webrole.yml': 'adx_webroleid: private-reader\nadx_name: Private Reader',
  'Private.webpageaccesscontrolrule.yml':
    'adx_webpageaccesscontrolruleid: private-rule\nadx_webpageid: private\nadx_name: Private page\nadx_right: 2\nadx_scope: 0\nadx_webpageaccesscontrolrule_webrole:\n  - private-reader',
  'Edit.basicform.yml':
    'adx_entityformid: edit-widget\nadx_name: Edit widget\nadx_entityname: widget\nadx_mode: 100000001\nadx_entitypermissionsenabled: true',
};

async function fixture(t, observed) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-modal-shell-'));
  ownedFixture(t).remove(() => removeFixtureDirectory(root));
  await Promise.all(Object.entries(files).map(([name, source]) => fs.writeFile(path.join(root, name), source)));
  return ownedClose(
    t,
    await createSimulator({
      sourceDir: root,
      watch: false,
      observed,
      initial: {
        mappings: {
          contact: { entitySet: 'contacts', idColumn: 'contactid' },
          widget: { entitySet: 'widgets', idColumn: 'widgetid' },
        },
        tables: {
          contact: [
            { contactid: 'editor', fullname: 'Invented editor' },
            { contactid: 'visitor', fullname: 'Invented visitor' },
          ],
          widget: [{ widgetid: 'widget', title: 'Sample widget' }],
        },
        permissions: [
          { id: 'widgets-read', entity: 'widget', roles: ['Editor'], scope: 'global', operations: ['read'] },
        ],
        settings: { permissionMode: 'enforce' },
        simulator: {
          mode: 'local',
          pageMode: 'local',
          endpoints: [],
          componentSchemas: { 'edit-widget': { entity: 'widget', fields: [{ name: 'title', label: 'Title' }] } },
          externalAssets: false,
        },
      },
    }),
  );
}

test('an opted-in modal frame lets the signed-in host mount authored controls', async (t) => {
  const browser = ownedClose(t, await chromium.launch(browserLaunchOptions({ headless: true })));
  const app = await fixture(t, {
    modalFormShell: 'signed-in-zero-website',
    headers: { page: { 'Content-Security-Policy': "connect-src 'none'; img-src 'self' data:" } },
    evidence: 'Invented loopback shell fixture',
  });
  const context = await browser.newContext();
  await signInContext(context, app, 'editor', { roles: ['Editor'] });
  const page = await context.newPage();
  await page.goto(app.url);
  const shellUrl = new URL(shellPath, app.url).href;
  const response = page.waitForResponse((item) => item.url() === shellUrl);
  await page.getByRole('button', { name: 'Compare widgets' }).click();
  assert.equal((await response).status(), 200);
  const frame = page.frameLocator('#compare');
  const mode = frame.locator('#content-container #mode');
  await mode.waitFor();
  assert.equal(await mode.inputValue(), 'name');
  assert.equal(await frame.locator('meta[name="portal-user"]').getAttribute('content'), 'Invented editor');
  assert.equal(
    await frame.locator('#content-container').evaluate((node) => typeof node.ownerDocument.defaultView.jQuery),
    'function',
  );
  assert.equal(await frame.locator('#EntityFormControl').count(), 0);
  const ordering = app.state().diagnostics.find((item) => item.path === modalPath && item.code.startsWith('FRAME_'));
  assert.equal(ordering?.ordering, 'jquery-ready', 'the iframe load releases after ready handlers under the site CSP');
});

test('modal shell admission preserves form lookup and record permissions', async (t) => {
  const disabled = await fixture(t);
  const app = await fixture(t, {
    modalFormShell: 'signed-in-zero-website',
    requestValidation: 'aspnet-query',
    evidence: 'Invented loopback shell fixture',
  });
  const editor = signInHeaders(app, 'editor', { roles: ['Editor'] });
  const visitor = signInHeaders(app, 'visitor');
  const response = (target, headers) => fetch(app.url + target, { headers });
  const defaultResponse = await fetch(disabled.url + shellPath, { headers: signInHeaders(disabled, 'editor') });
  assert.equal(defaultResponse.status, 404);
  assert.equal((await response(shellPath)).status, 404, 'an anonymous visitor cannot open the shell');
  const head = await fetch(app.url + shellPath, { method: 'HEAD', headers: editor });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const post = await fetch(app.url + shellPath, {
    method: 'POST',
    headers: editor,
    body: new URLSearchParams({ __RequestVerificationToken: app.portalToken }),
  });
  assert.equal(post.status, 404, 'a form-less URL is not a postback target');
  for (const target of [
    modalPath,
    `${modalRoot}/widget-site/?purpose=compare`,
    `${modalRoot}/?purpose=compare`,
    `${modalPath}?entityformid=missing&purpose=compare`,
    `${modalPath}?entityform=&purpose=compare`,
    `${modalPath}?EntityFormID=missing&purpose=compare`,
    `${modalPath}?PAGEID=private&purpose=compare`,
    `${modalPath}?pageid=missing&purpose=compare`,
  ])
    assert.equal((await response(target, editor)).status, 404, target);
  assert.equal((await response(`${shellPath}&pageid=private`, visitor)).status, 403);
  const invalidQuery = await response(`${modalPath}?purpose=%3Cnote`, editor);
  assert.equal(invalidQuery.status, 500);
  assert.doesNotMatch(await invalidQuery.text(), /<meta name="portal-user"/);
  const allowed = await response(`${modalPath}?${formQuery}`, editor);
  assert.equal(allowed.status, 200);
  assert.match(await allowed.text(), /value="Sample widget"/);
  const denied = await response(`${modalPath}?${formQuery}`, visitor);
  assert.equal(denied.status, 200);
  const deniedHtml = await denied.text();
  assert.match(deniedHtml, /appropriate permissions/i);
  assert.doesNotMatch(deniedHtml, /Sample widget/);

  const liveData = await fetch(`${app.adminOrigin}/_sim/api/config`, {
    method: 'PATCH',
    headers: { 'x-sim-csrf': app.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'live', identity: { contactId: 'editor', roles: ['Editor'] } }),
  });
  assert.equal(liveData.status, 200, await liveData.text());
  assert.equal((await response(shellPath, visitor)).status, 404, 'live data mode uses a different configured identity');
});

test('the exported-or-zero shell mode accepts either website ID and optional query for signed-in reads', async (t) => {
  const app = await fixture(t, {
    modalFormShell: 'signed-in-exported-or-zero-website',
    evidence: 'Invented loopback fixture for the expanded shell routes',
  });
  const editor = signInHeaders(app, 'editor', { roles: ['Editor'] });
  const response = (target, headers) => fetch(app.url + target, { headers });
  const sitePath = `${modalRoot}/widget-site/`;
  for (const target of [modalPath, shellPath, sitePath, `${sitePath}?purpose=compare`]) {
    const shell = await response(target, editor);
    assert.equal(shell.status, 200, target);
    assert.match(await shell.text(), /id="content-container"/, target);
    assert.equal((await response(target)).status, 404, 'an anonymous visitor cannot open the shell');
  }
  for (const target of [
    `${modalRoot}/?purpose=compare`,
    `${modalRoot}/other-site/?purpose=compare`,
    `${sitePath}?entityformid=missing`,
    `${sitePath}?entityform=`,
  ])
    assert.equal((await response(target, editor)).status, 404, target);
  const explicit = await response(`${sitePath}?${formQuery}`, editor);
  assert.equal(explicit.status, 200);
  assert.match(await explicit.text(), /value="Sample widget"/);
});
