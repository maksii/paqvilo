// @test-kind contract: Paqvilo's own create dialogs, lookups and grid refresh behaviour (designed runtime)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { parse } from 'parse5';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { closeServer } from './shared-browser.mjs';

// A record form with a Create related record action whose target form opens
// in a modal, and the record state hiding the inapplicable state action.
test('create related record opens the target form dialog; the record state hides its state action', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'native-create-related-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const actions = [
    { Type: 'DeactivateAction', ButtonLabel: [{ LCID: 1033, Value: 'Close entry' }] },
    { Type: 'ActivateAction', ButtonLabel: [{ LCID: 1033, Value: 'Reopen entry' }] },
    {
      Type: 'CreateRelatedRecordAction',
      ButtonLabel: [{ LCID: 1033, Value: 'Add note' }],
      ButtonTooltip: [{ LCID: 1033, Value: 'Add a related note' }],
      EntityFormId: 'note-form',
      ShowModal: 1,
      TargetType: 0,
    },
  ];
  const files = {
    'website.yml': 'adx_websiteid: 11111111-2222-4333-8444-555555555555\nadx_name: Related fixture',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '{% entityform name: "Entry" %}',
    'Entry.basicform.yml': `adx_entityformid: entry-form\nadx_name: Entry\nadx_entityname: sample\nadx_mode: 100000001\nadx_entitysourcetype: 756150001\nadx_recordidquerystringparametername: row\nadx_settings: ${JSON.stringify(JSON.stringify({ Actions: actions }))}`,
    'Note.basicform.yml': 'adx_entityformid: note-form\nadx_name: Note\nadx_entityname: sample\nadx_mode: 100000000',
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(root, name), content);
  const id = '00000000-0000-4000-8000-000000000001';
  const fields = [{ name: 'title', label: 'Title', type: 'text' }];
  const app = await createSimulator({
    sourceDir: root,
    watch: false,
    initial: {
      mappings: {
        sample: {
          entitySet: 'samples',
          idColumn: 'sampleid',
          nameColumn: 'title',
          fieldMetadata: {
            title: { dataverseType: 'nvarchar' },
            statecode: {
              dataverseType: 'state',
              states: [
                { value: 0, defaultStatus: 100 },
                { value: 1, defaultStatus: 300 },
              ],
            },
            statuscode: {
              dataverseType: 'status',
              statuses: [
                { value: 100, state: 0 },
                { value: 300, state: 1 },
              ],
            },
          },
        },
      },
      tables: { sample: [{ sampleid: id, title: 'Original', statecode: 0, statuscode: 100 }] },
      permissions: [{ entity: 'sample', scope: 'global', roles: ['Editor'], operations: ['read', 'update', 'create'] }],
      settings: { permissionMode: 'enforce', 'Webapi/sample/enabled': false, 'Site/BootstrapV5Enabled': 'true' },
      simulator: {
        componentSchemas: { 'entry-form': { entity: 'sample', fields }, 'note-form': { entity: 'sample', fields } },
        endpoints: [],
        mode: 'local',
        pageMode: 'local',
        live: { origin: null },
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const context = await browser.newContext();
  await signInContext(context, app, 'editor', { roles: ['Editor'] });
  const page = await context.newPage();
  const response = await page.goto(`${app.url}/?row=${id}`);
  const html = await response.text();
  // Server markup: both state buttons, no hidden marker; the form dialog with an empty frame.
  const descendants = (root) => {
    const nodes = [],
      pending = [root];
    while (pending.length) {
      const node = pending.pop();
      if (node.tagName) nodes.push(node);
      pending.push(...(node.childNodes ?? []));
    }
    return nodes;
  };
  const nodes = descendants(parse(html)),
    attribute = (node, name) => node.attrs.find((attr) => attr.name === name)?.value;
  const hasClass = (node, name) => (attribute(node, 'class') ?? '').split(/\s+/).includes(name);
  const activate = nodes.filter((node) => node.tagName === 'button' && hasClass(node, 'activate-link'));
  const deactivate = nodes.filter((node) => node.tagName === 'button' && hasClass(node, 'deactivate-link'));
  assert.equal(activate.length, 1);
  assert.equal(deactivate.length, 1);
  assert.equal(attribute(activate[0], 'class'), 'activate-link btn btn-default btn');
  assert.equal(attribute(activate[0], 'type'), 'button');
  assert.equal(typeof attribute(activate[0], 'data-url'), 'string');
  assert.equal(typeof attribute(activate[0], 'href'), 'string');
  assert.equal(activate[0].childNodes.map((node) => node.value ?? '').join(''), 'Reopen entry');
  for (const button of [...activate, ...deactivate]) {
    assert.equal(hasClass(button, 'hidden'), false);
    assert.equal(attribute(button, 'style'), undefined);
  }
  const dialogs = nodes.filter((node) => node.tagName === 'section' && hasClass(node, 'modal-form-createrecord'));
  assert.equal(dialogs.length, 1);
  const dialog = dialogs[0];
  assert.equal(attribute(dialog, 'class'), 'modal fade modal-form modal-form-createrecord');
  assert.equal(attribute(dialog, 'data-bs-backdrop') ?? attribute(dialog, 'data-backdrop'), 'static');
  assert.match(attribute(dialog, 'data-filtercriteriaid'), /^[0-9a-f-]{36}$/i);
  assert.equal(attribute(dialog, 'role'), 'dialog');
  assert.equal(attribute(dialog, 'tabindex'), '-1');
  assert.equal(
    attribute(
      dialog.childNodes.find((node) => node.tagName),
      'class',
    ),
    'modal-lg modal-dialog',
  );
  const initialFrame = descendants(dialog).find((node) => node.tagName === 'iframe');
  assert.equal(attribute(initialFrame, 'src'), 'about:blank');
  const layout = JSON.parse(
    attribute(
      nodes.find((node) => attribute(node, 'data-form-layout')),
      'data-form-layout',
    ),
  );
  const action = layout.CreateRelatedRecordActionLink;
  assert.deepEqual(
    {
      Modal: action.Modal,
      EntityForm: action.EntityForm,
      Target: action.Target,
      Type: action.Type,
      Label: action.Label,
      Tooltip: action.Tooltip,
      Enabled: action.Enabled,
    },
    {
      Modal: {},
      EntityForm: { Id: 'note-form', LogicalName: 'adx_entityform', KeyAttributes: [] },
      Target: 0,
      Type: 29,
      Label: 'Add note',
      Tooltip: 'Add a related note',
      Enabled: true,
    },
  );
  // The app bundle hides the state action the active record rules out.
  assert.equal(await page.locator('button.activate-link.hidden').count(), 1);
  assert.equal(await page.locator('button.activate-link').getAttribute('style'), 'display: none;');
  assert.equal(await page.locator('button.deactivate-link.hidden').count(), 0);
  // The action opens the dialog on the target form with the record and the page language.
  await page.locator('button.create-related-record-link').click();
  const modal = page.locator('section.modal-form-createrecord');
  await modal.waitFor({ state: 'visible' });
  const src = await modal.locator('iframe').getAttribute('src');
  assert.equal(
    src,
    `/_portal/modal-form-template-path/11111111-2222-4333-8444-555555555555?id=${id}&entityformid=note-form&languagecode=1033`,
  );
  assert.equal(await modal.getAttribute('aria-label'), ' Create related record');
  // The click sets the frame source and shows the dialog in one step; the frame commits its document later.
  const child = await (await modal.locator('iframe').elementHandle()).contentFrame();
  await child.waitForURL(app.url + src);
  await child.locator('#title').waitFor();
  const target = await child.locator('script[data-paqvilo-mirage-form-config]').evaluate((node) => {
    const config = JSON.parse(node.textContent);
    return { kind: config.kind, formId: config.formId, operation: config.operation };
  });
  assert.deepEqual(
    target,
    { kind: 'entityform', formId: 'note-form', operation: 'create' },
    'the dialog renders the target insert form instead of inheriting the parent edit form',
  );
  assert.equal(
    await child
      .locator('[data-form-layout]')
      .evaluate((node) => JSON.parse(node.getAttribute('data-form-layout')).EntityName),
    'sample',
  );
});

const LOOKUP_LAYOUT = {
  Id: 'view-1',
  ViewName: 'First',
  Configuration: { ViewDisplayName: 'First' },
  Columns: [{ LogicalName: 'name', Name: 'Name', Width: 100, WidthAsPercent: 100 }],
  Base64SecureConfiguration: 'secure-1',
  SortExpression: 'name ASC',
};
const LOOKUP_PAGE = `<!doctype html><html lang="en"><head><title>Lookup</title></head><body>
<div id="antiforgerytoken"><input type="hidden" name="__RequestVerificationToken" value="token"></div>
<div class="entity-lookup" data-lookup-datafieldname="owner">
  <section class="modal-lookup"><div class="entity-grid" data-get-url="/grid-data" data-defer-loading="true" data-select-mode="Single" data-view-layouts='${JSON.stringify([LOOKUP_LAYOUT])}'><div class="view-grid"></div><div class="view-pagination"></div></div><div class="modal-footer"><button class="new-value">Create owner</button></div></section>
  <section class="modal modal-lookup-create-form" aria-hidden="true" style="display:none"><div class="form-loading">Loading form</div><iframe data-page="/form"></iframe><button data-dismiss="modal">Cancel</button></section>
</div>
<script src="/jquery.js"></script><script src="/grid.js"></script></body></html>`;

async function openAndCancelCreate(page) {
  await page.locator('.new-value').click();
  const dialog = page.locator('.modal-lookup-create-form');
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'hidden' });
}

// Each cancelled create must not keep its success listener, so one successful create refreshes the lookup once.
test('a cancelled lookup create dialog leaves no success listener behind, so one create refreshes the lookup once', async (t) => {
  const grid = await fs.readFile(new URL('../lib/entity-grid-compat.js', import.meta.url));
  const jquery = await fs.readFile(new URL('../node_modules/jquery/dist/jquery.min.js', import.meta.url));
  const server = http.createServer((request, response) => {
    if (request.url === '/jquery.js' || request.url === '/grid.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end(request.url === '/grid.js' ? grid : jquery);
      return;
    }
    if (request.url === '/grid-data') {
      request.resume();
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ Records: [], ItemCount: 0 }));
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(
      request.url.startsWith('/form') ? '<form id="EntityFormControl"><input aria-label="Name"></form>' : LOOKUP_PAGE,
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(server));
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const context = await browser.newContext();
  t.after(() => context.close());
  // Counts the grid's own POSTs in the page. jQuery sends them through XMLHttpRequest, so the count is final once the
  // refresh's request event has been delivered: the listeners of one message dispatch run synchronously.
  await context.addInitScript(() => {
    window.__gridPosts = 0;
    const open = XMLHttpRequest.prototype.open,
      send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__gridPost = method.toUpperCase() === 'POST' && new URL(url, location.href).pathname === '/grid-data';
      return open.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      if (this.__gridPost) window.__gridPosts++;
      return send.apply(this, args);
    };
  });
  const page = await context.newPage(),
    errors = [],
    refreshes = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/grid-data') refreshes.push(request.url());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await openAndCancelCreate(page);
  await openAndCancelCreate(page);
  // The create form reports success to the page; the listener of the open dialog runs once.
  await page.locator('.new-value').click();
  await page.locator('.modal-lookup-create-form').waitFor({ state: 'visible' });
  const refreshed = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/grid-data',
  );
  const posted = page.evaluate(
    () =>
      new Promise((resolve) => {
        window.addEventListener('message', () => resolve(), { once: true });
        window.postMessage(
          JSON.stringify({ type: 'Success', id: '00000000-0000-4000-8000-000000000002' }),
          location.origin,
        );
      }),
  );
  await Promise.all([refreshed, posted]);
  assert.equal(await page.evaluate(() => window.__gridPosts), 1);
  assert.equal(refreshes.length, 1);
  assert.equal(await page.locator('.modal-lookup-create-form').evaluate((node) => node.style.display), 'none');
  assert.deepEqual(errors, []);
});
