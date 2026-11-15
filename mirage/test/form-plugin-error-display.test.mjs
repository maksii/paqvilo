// @test-kind observation: native Power Pages basic-form plug-in refusal display, 7 captures on 2026-11-15 (Insert and Edit forms, synchronous PreValidation InvalidPluginExecutionException, Site/EnableCustomPluginError absent and true)
// Invented schema and loopback fixtures only. A refused basic-form save re-renders the form with the generic Error ID text, or the
// plug-in's message when Site/EnableCustomPluginError is true; the trace and the runtime diagnostic keep the plug-in's message.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { nativeFormControlIds } from '../lib/native-postback.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { endedTree } from './support/trace-scenario.mjs';

const REFUSAL = 'Invented refusal: title too short.';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unknownFailure = (id) => `An unknown failure has occurred. Error ID # [${id}]`;
const element = (html, pattern) => {
  const match = html.match(pattern);
  assert.ok(match, `missing ${pattern}`);
  return match[0];
};

async function fixture(t, { edit = false, customPluginError } = {}) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'form-plugin-error-display-'));
  const settings = [
    ['Site/BootstrapV5Enabled', 'true'],
    ...(customPluginError === undefined ? [] : [['Site/EnableCustomPluginError', customPluginError]]),
  ];
  const files = {
    'website.yml': 'adx_websiteid: fixture-site\nadx_name: Invented plug-in error display',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml':
      'adx_pagetemplateid: template\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '<form id="liquid_form">{% entityform name: "Item" %}</form>',
    'Item.basicform.yml': `adx_entityformid: item\nadx_name: Item\nadx_mode: ${edit ? 100000001 : 100000000}\nadx_recordidquerystringparametername: itemid`,
    'sitesetting.yml': settings
      .map(([name, value], index) => `- adx_sitesettingid: s${index}\n  adx_name: ${name}\n  adx_value: "${value}"`)
      .join('\n'),
  };
  for (const [name, source] of Object.entries(files)) await fs.writeFile(path.join(root, name), source);
  const app = await createSimulator({
    sourceDir: root,
    watch: false,
    trace: { level: 'full' },
    initial: {
      mappings: {
        item: {
          entitySet: 'items',
          idColumn: 'itemid',
          fields: { title: { dataverseType: 'nvarchar' }, description: { dataverseType: 'memo' } },
        },
      },
      tables: { item: [{ itemid: 'item-1', title: 'Stored title', description: 'Stored description' }] },
      settings: { permissionMode: 'permissive' },
      // The local model of the captured PreValidation step: an invented declarative rule that refuses a short title.
      plugins: [
        {
          id: 'short-title',
          entity: 'item',
          operations: ['create', 'update'],
          validate: [{ field: 'title', pattern: '^.{3,}', message: REFUSAL }],
        },
      ],
      simulator: {
        mode: 'local',
        pageMode: 'local',
        identity: { roles: [] },
        live: {},
        endpoints: [],
        componentSchemas: {
          item: {
            entity: 'item',
            fields: [
              { name: 'title', type: 'text', label: 'Title' },
              { name: 'description', type: 'textarea', label: 'Description' },
            ],
          },
        },
      },
    },
  });
  ownedFixture(t).add(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const route = edit ? '/?itemid=item-1' : '/';
  const controls = nativeFormControlIds('entityform', 'item');
  const post = (button, values) =>
    fetch(app.url + route, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([
        ['__EVENTTARGET', controls.buttons + button],
        ['__EVENTARGUMENT', ''],
        ['__RequestVerificationToken', app.csrf],
        ...Object.entries(values).map(([key, value]) => [controls.names + key, value]),
      ]),
    });
  return { app, post, route };
}

/** The refused form: HTTP 200, an HTML page with the Bootstrap 5 danger panel above the form, and no redirect. */
async function refused(response, text) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.equal(response.headers.get('location'), null);
  const html = await response.text();
  assert.match(
    html,
    new RegExp(
      `<div id="MessagePanel" class="message alert alert-danger" role="alert"><input type="submit" [^>]*id="btnCloseMessage"[^>]*><span id="MessageLabel" aria-live="polite" aria-atomic="true"><p class="text-danger"><span class="fa fa-exclamation-triangle" aria-hidden="true"></span> ${escapeRegExp(text)}</p></span></div><div id="EntityFormPanel"`,
    ),
  );
  return html;
}

test("a plug-in refusal of a basic-form insert shows the unknown failure with the response's request id when Site/EnableCustomPluginError is absent", async (t) => {
  const { app, post, route } = await fixture(t);
  const first = await fetch(app.url + route);
  assert.doesNotMatch(await first.text(), /<input [^>]*id="btnCloseMessage"/);
  const response = await post('InsertButton', { title: 'ab' });
  const id = response.headers.get('x-ms-request-id');
  assert.match(id, GUID);
  const html = await refused(response, unknownFailure(id));
  assert.doesNotMatch(html, /Invented refusal/);
  assert.equal(app.store.snapshot().tables.item.length, 1);
  const second = await post('InsertButton', { title: 'ab' });
  const secondId = second.headers.get('x-ms-request-id');
  assert.match(secondId, GUID);
  assert.notEqual(secondId, id);
  await second.text();
});

test('a plug-in refusal of a basic-form update keeps the posted values and the stored record when Site/EnableCustomPluginError is absent', async (t) => {
  const { app, post } = await fixture(t, { edit: true });
  const response = await post('UpdateButton', { title: 'ab', description: 'Posted description' });
  const id = response.headers.get('x-ms-request-id');
  assert.match(id, GUID);
  const html = await refused(response, unknownFailure(id));
  assert.match(element(html, /<input [^>]*id="title"[^>]*>/), /value="ab"/);
  assert.match(html, /<textarea [^>]*id="description"[^>]*>Posted description<\/textarea>/);
  assert.deepEqual(app.store.snapshot().tables.item, [
    { itemid: 'item-1', title: 'Stored title', description: 'Stored description' },
  ]);
});

test("Site/EnableCustomPluginError true shows the plug-in's exception message exactly on insert and update", async (t) => {
  const created = await fixture(t, { customPluginError: 'true' });
  const insert = await created.post('InsertButton', { title: 'ab' });
  const insertHtml = await refused(insert, REFUSAL);
  assert.doesNotMatch(insertHtml, /An unknown failure has occurred|Error ID/);
  assert.equal(created.app.store.snapshot().tables.item.length, 1);

  const edited = await fixture(t, { edit: true, customPluginError: 'true' });
  const update = await edited.post('UpdateButton', { title: 'ab', description: 'Posted description' });
  const updateHtml = await refused(update, REFUSAL);
  assert.doesNotMatch(updateHtml, /An unknown failure has occurred|Error ID/);
  assert.deepEqual(edited.app.store.snapshot().tables.item, [
    { itemid: 'item-1', title: 'Stored title', description: 'Stored description' },
  ]);
});

// @test-kind unproven: other casings of the setting were not captured; the case-insensitive parse follows the toolkit's other Boolean site settings (Site/BootstrapV5Enabled)
test('Site/EnableCustomPluginError is read case-insensitively', async (t) => {
  const { post } = await fixture(t, { customPluginError: 'TRUE' });
  await refused(await post('InsertButton', { title: 'ab' }), REFUSAL);
});

// @test-kind compatibility: Microsoft Learn, Display plug-in error (https://learn.microsoft.com/power-pages/admin/view-portal-error-log#display-plugin-error): absent is false; an explicit false was not captured
test('Site/EnableCustomPluginError false keeps the unknown failure text', async (t) => {
  const { post } = await fixture(t, { customPluginError: 'false' });
  const response = await post('InsertButton', { title: 'ab' });
  const id = response.headers.get('x-ms-request-id');
  assert.match(id, GUID);
  await refused(response, unknownFailure(id));
});

// @test-kind contract: Paqvilo's tracing and diagnostics design (docs/design/tracing.md): a refused activity keeps the plug-in's message whatever the page shows
test("the trace and the runtime diagnostic keep the plug-in's message and the Error ID while the page hides it", async (t) => {
  const { app, post } = await fixture(t);
  const response = await post('InsertButton', { title: 'ab' });
  const id = response.headers.get('x-ms-request-id');
  const html = await response.text();
  assert.match(html, /An unknown failure has occurred/);
  const tree = await endedTree(app.trace, response.headers.get('x-trace-id'));
  assert.ok(tree.spans.some((span) => span.error?.message === REFUSAL));
  assert.ok(app.state().diagnostics.some((entry) => entry.message === REFUSAL && entry.errorId === id));
});
