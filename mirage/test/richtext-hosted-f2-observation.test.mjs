// @test-kind observation: hosted session F2 (paqvilo-developer hosted-f2 summary-F2 API-05b, runs a and b of the choices and choices-rte groups agree): a rich text column whose FormXml binds only the rich text editor renders the plain native textarea, code component metadata on it makes the platform host RichTextEditorControlV2, whose EntityDefinitions read the portal refuses with 403, and a Web API PATCH stores markup as sent; restated on an invented table
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { renderComponent } from '../lib/platform.mjs';
import { nativeFormControlIds } from '../lib/native-postback.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const EDITOR = { name: 'MscrmControls.RichTextEditor.RichTextEditorControl' };
const CODE_COMPONENT = 756150001;
// The captured form: the rich text column with the editor bound in FormXml beside a second rich text column without it.
const FIELDS = [
  { name: 'x_story', label: 'Story', dataverseType: 'memo', format: 'RichText', maxLength: 4000, richText: EDITOR },
  { name: 'x_notes', label: 'Notes', dataverseType: 'memo', format: 'RichText', maxLength: 4000 },
];
const editorMetadata = (form) => ({
  kind: 'basicformmetadata',
  adx_entityform: form,
  adx_type: 100000000,
  adx_attributelogicalname: 'x_story',
  adx_controlstyle: CODE_COMPONENT,
});

async function render(records) {
  const diagnostics = [];
  const html = await renderComponent(
    'entityform',
    'Story',
    {},
    {
      portal: { forms: [{ id: 'story', name: 'Story', mode: 100000000 }], records, webFiles: [] },
      store: { resolveMapping: () => ({ idColumn: 'x_rowid' }) },
      schemas: { story: { entity: 'x_row', fields: FIELDS } },
      diagnostic: (entry) => diagnostics.push(entry),
    },
  );
  return { html: String(html.html ?? html), diagnostics };
}

// The form-group of one column with its name replaced, to compare two cells.
const cell = (html, name) => {
  const start = html.indexOf(`<div class="form-group"><div class="info"><label for="${name}"`);
  return html.slice(start, html.indexOf('</textarea></div></div>', start)).replaceAll(name, 'COLUMN');
};

test('a FormXml-only rich text editor binding renders the plain native textarea of its column', async () => {
  const { html, diagnostics } = await render([]);
  // Captured: <textarea ... rows="4" cols="20" maxlength="4000" id="..." class="textarea form-control " ...
  // onkeydown/oninput LimitInput, onpaste LimitPaste>, identical to the rich text column without the editor binding.
  assert.match(
    html,
    /<textarea name="[^"]*\$x_story" rows="4" cols="20" maxlength="4000" id="x_story" class="textarea form-control " onchange="setIsDirty\(this\.id\);" aria-label="Story" onkeydown="javascript:return LimitInput\(this, event\);" oninput="javascript:return LimitInput\(this, event\);" onpaste="javascript:return LimitPaste\(this, event\);">/,
  );
  assert.equal(cell(html, 'x_story').replaceAll('Story', 'LABEL'), cell(html, 'x_notes').replaceAll('Notes', 'LABEL'));
  assert.doesNotMatch(html, /data-sim-richtext|PcfControl_x_story|x_story_editor/);
  assert.deepEqual(
    diagnostics.filter((entry) => entry.code === 'RICHTEXT_HOSTED_V2_CONTROL'),
    [],
  );
});

test('code component metadata on the rich text column renders the editor and names the hosted V2 control', async () => {
  const { html, diagnostics } = await render([editorMetadata('story')]);
  assert.match(html, /<div id="PcfControl_x_story" data-sim-richtext-editor/);
  assert.match(
    html,
    /<input type="hidden" id="x_story" name="[^"]*\$x_story" value="&quot;&quot;" data-sim-richtext-value>/,
  );
  // The column beside it, without the editor binding, stays a textarea.
  assert.match(html, /<textarea name="[^"]*\$x_notes" rows="4" cols="20" maxlength="4000" id="x_notes"/);
  assert.deepEqual(
    diagnostics
      .filter((entry) => /^(RICHTEXT_|PCF_NATIVE_BINDING_UNSUPPORTED)/.test(entry.code))
      .map((entry) => [entry.code, entry.field]),
    [['RICHTEXT_HOSTED_V2_CONTROL', 'x_story']],
  );
  assert.match(
    diagnostics.find((entry) => entry.code === 'RICHTEXT_HOSTED_V2_CONTROL').message,
    /MscrmControls\.RichTextEditorV2\.RichTextEditorControlV2 from \/_pcfwebresource/,
  );
});

async function site(t, { editor = false, settings = [] } = {}) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'richtext-hosted-f2-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_websiteid: site\nadx_name: Invented rich text',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html':
      '<!doctype html><html><body><form id="liquid_form">{% entityform name: "Story" %}</form></body></html>',
    'Story.basicform.yml':
      'adx_entityformid: story\nadx_name: Story\nadx_entityname: x_row\nadx_mode: 100000000\nadx_successmessage: Saved',
    'sitesetting.yml': [
      "- adx_name: Webapi/x_row/enabled\n  adx_value: 'true'",
      "- adx_name: Webapi/x_row/fields\n  adx_value: 'x_story,x_notes'",
      ...settings.map(([name, value]) => `- adx_name: ${name}\n  adx_value: '${value}'`),
    ].join('\n'),
  };
  if (editor)
    files['Story.basicformmetadata.yml'] =
      'adx_entityformmetadataid: story-editor\nadx_entityform: story\nadx_type: 100000000\nadx_attributelogicalname: x_story\nadx_controlstyle: 756150001';
  for (const [name, source] of Object.entries(files)) await fs.writeFile(path.join(root, name), source);
  const app = await createSimulator({
    sourceDir: root,
    watch: false,
    initial: {
      mappings: {
        x_row: {
          entitySet: 'x_rows',
          idColumn: 'x_rowid',
          fields: {
            x_rowid: { dataverseType: 'uniqueidentifier' },
            x_story: { dataverseType: 'memo', format: 'RichText', maxLength: 4000 },
            x_notes: { dataverseType: 'memo', format: 'RichText', maxLength: 4000 },
          },
        },
      },
      tables: { x_row: [{ x_rowid: '11111111-1111-4111-8111-111111111111', x_story: 'Before' }] },
      settings: { permissionMode: 'permissive' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        identity: { id: 'invented-editor', roles: [] },
        live: {},
        endpoints: [],
        componentSchemas: { story: { entity: 'x_row', fields: FIELDS } },
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  return app;
}

async function postStory(app, value) {
  const page = await fetch(app.url + '/');
  assert.equal(page.status, 200);
  const html = await page.text();
  const controls = nativeFormControlIds('entityform', 'story');
  const response = await fetch(app.url + '/', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      __EVENTTARGET: controls.buttons + 'InsertButton',
      __EVENTARGUMENT: '',
      __RequestVerificationToken: app.portalToken,
      [controls.names + 'x_story']: value,
    }),
  });
  assert.equal(response.status, 200);
  await response.text();
  return { html, saved: app.store.snapshot().tables.x_row.at(-1).x_story };
}

test('the FormXml-only rich text column posts and saves its textarea text as typed', async (t) => {
  const app = await site(t);
  const { html, saved } = await postStory(app, '"Quoted" opening words');
  assert.match(html, /<textarea name="[^"]*\$x_story" rows="4" cols="20" maxlength="4000" id="x_story"/);
  assert.equal(saved, '"Quoted" opening words');
});

test('with code component metadata the rich text column posts the editor HTML as its JSON string', async (t) => {
  const app = await site(t, { editor: true });
  const { html, saved } = await postStory(app, JSON.stringify('<p>Formatted <strong>story</strong></p>'));
  assert.match(html, /data-sim-richtext-value/);
  assert.equal(saved, '<p>Formatted <strong>story</strong></p>');
});

test("the hosted editor's EntityDefinitions read from a portal page is refused with 403", async (t) => {
  const app = await site(t, { editor: true });
  // Captured: GET /api/data/v9.1/EntityDefinitions(LogicalName='<table>')?$select=LogicalName,DisplayName -> 403.
  const response = await fetch(
    app.url + "/api/data/v9.1/EntityDefinitions(LogicalName='x_row')?$select=LogicalName,DisplayName",
    { headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } },
  );
  assert.equal(response.status, 403);
  await response.text();
});

test('a Web API PATCH stores rich text markup, scripts included, as sent', async (t) => {
  const app = await site(t);
  const markup = '<p>web api <b>rich</b></p><script>x()</script>';
  const response = await fetch(app.url + '/_api/x_rows(11111111-1111-4111-8111-111111111111)', {
    method: 'PATCH',
    headers: { __RequestVerificationToken: app.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ x_story: markup }),
  });
  assert.equal(response.status, 204, await response.text());
  assert.equal(app.store.snapshot().tables.x_row[0].x_story, markup);
});

test('shell capture asks for editor assets only for a rich text column the editor renders on', async () => {
  const { captureRichTextAssets } = await import('../lib/richtext-assets.mjs');
  const live = { origin: 'https://portal.example.test', status: () => ({ connected: true }) };
  const control = { name: 'MscrmControls.RichTextEditor.RichTextEditorControl' };
  const schemas = {
    'form-a': { fields: [{ name: 'x_body', richText: control }] },
    'form-b': { fields: [{ name: 'x_body', richText: control }] },
  };
  const metadata = (form) => ({
    kind: 'basicformmetadata',
    adx_entityform: { id: form },
    adx_type: 100000000,
    adx_attributelogicalname: 'x_body',
    adx_controlstyle: 756150001,
  });
  // FormXml-only bindings on both forms: plain textareas, no editor assets.
  const none = await captureRichTextAssets(null, live, { schemas, portal: { records: [] } });
  assert.equal(none.required, false);
  assert.equal(none.skipped, 'NO_RICH_TEXT_FIELDS');
  // Code component metadata on one form: that form's column needs the editor.
  const one = await captureRichTextAssets(null, live, { schemas, portal: { records: [metadata('form-b')] } });
  assert.equal(one.required, true);
});

// @test-kind unproven: inferred; the editor-bound input could not be posted on the hosted site (state-0 runs: setting input#pqf2_rich directly answers 500 for any value), so a field the editor renders follows the same rule as a plain field (hosted F2 state-0 s0g/s0h/s0r, s0i/s0j)
test('a field the editor renders follows the same request validation rule as a plain field', async (t) => {
  const app = await site(t, { editor: true });
  const refused = await postStory(app, JSON.stringify('<p>Story</p><script>alert(1)</script>'));
  assert.equal(refused.saved, 'Before');
  const accepted = await postStory(app, JSON.stringify('<p>Story</p><img src="x" onerror="alert(1)">'));
  assert.equal(accepted.saved, '<p>Story</p><img src="x" onerror="alert(1)">');
  const strict = await site(t, { editor: true, settings: [['Site/DisableFormDataSafeHtmlValidation', 'false']] });
  const handler = await postStory(strict, JSON.stringify('<p>Story</p><img src="x" onerror="alert(1)">'));
  assert.equal(handler.saved, 'Before');
  const saved = await postStory(strict, JSON.stringify('<p>Formatted <strong>story</strong></p>'));
  assert.equal(saved.saved, '<p>Formatted <strong>story</strong></p>');
});
