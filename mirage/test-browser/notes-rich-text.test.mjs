// Rich text notes (Timeline/RTEEnabled) and the activity timeline in a browser: a full simulator for the notes editor and
// sanitization, a loopback page for the timeline client.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { loopbackServer, sharedBrowser } from './shared-browser.mjs';

const browser = sharedBrowser({ headless: true });
const GADGET = '30000000-0000-4000-8000-000000000001';
const FOREIGN = '30000000-0000-4000-8000-000000000002';
const EDITOR = '30000000-0000-4000-8000-000000000010';
const XSS =
  '<p>Hello <b>team</b></p><script>window.__xss=1</script><img src="/missing.png" onerror="window.__xss=2"><a href="javascript:window.__xss=3">go</a><iframe srcdoc="<script>parent.__xss=4</script>"></iframe><p onclick="window.__xss=5">done</p>';

async function notesSite(t, { bootstrap5 }) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'notes-rte-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_websiteid: site\nadx_name: Notes fixture',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '{% entityform name: "Gadget" %}',
    'Gadget.basicform.yml':
      'adx_entityformid: gadget-form\nadx_name: Gadget\nadx_entityname: pqx_gadget\nadx_mode: 100000001\nadx_entitysourcetype: 756150001\nadx_recordidquerystringparametername: id',
    'Gadget.basicform.basicformmetadata.yml': `adx_entityformmetadataid: gadget-notes\nadx_entityform: gadget-form\nadx_type: 100000005\nadx_notes_settings: '${JSON.stringify({ CreateEnabled: true, EditEnabled: true, DeleteEnabled: true })}'`,
    'sitesetting.yml': `- adx_name: Timeline/RTEEnabled\n  adx_value: true${bootstrap5 ? '\n- adx_name: Site/BootstrapV5Enabled\n  adx_value: true' : ''}`,
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(root, name), content);
  const app = await createSimulator({
    sourceDir: root,
    port: 0,
    watch: false,
    richTextCompatibility: true,
    initial: {
      mappings: {
        pqx_gadget: { entitySet: 'pqx_gadgets', idColumn: 'pqx_gadgetid', nameColumn: 'pqx_name' },
        annotation: { entitySet: 'annotations', idColumn: 'annotationid', nameColumn: 'subject' },
        contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
      },
      tables: {
        pqx_gadget: [{ pqx_gadgetid: GADGET, pqx_name: 'Gadget' }],
        contact: [{ contactid: EDITOR, fullname: 'Editor', statecode: 0 }],
        // Stored outside the portal by another author: never sanitized on write.
        annotation: [
          {
            annotationid: FOREIGN,
            notetext: `*WEB*${XSS}`,
            subject: 'Note created by Author [contact:author]',
            objectid: { id: GADGET, logical_name: 'pqx_gadget' },
            objecttypecode: 'pqx_gadget',
            createdon: '2026-01-01T00:00:00Z',
          },
        ],
      },
      permissions: [],
      settings: { permissionMode: 'permissive' },
      simulator: {
        componentSchemas: {
          'gadget-form': {
            entity: 'pqx_gadget',
            fields: [{ name: 'pqx_name', type: 'text' }],
            layout: [
              {
                name: 'main',
                label: 'Main',
                columns: [
                  {
                    width: '100%',
                    sections: [
                      {
                        name: 'details',
                        label: 'Details',
                        rows: [[{ name: 'pqx_name' }], [{ type: 'notes', id: 'notescontrol', label: 'Notes' }]],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  return app;
}

// @test-kind security: with rich text notes, markup another author stored is shown sanitized (no script, handler, javascript: link or frame runs), and a note added through the rich text editor is stored without the markup the editor's sanitizer and the service remove.
test('rich text notes render sanitized markup and save editor HTML without executable content', async (t) => {
  for (const bootstrap5 of [true, false]) {
    await t.test(bootstrap5 ? 'Bootstrap 5' : 'Bootstrap 3', async (sub) => {
      const app = await notesSite(sub, { bootstrap5 });
      const page = await browser.page(sub);
      await signInContext(page.context(), app, EDITOR);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${app.url}/?id=${GADGET}`);
      const foreign = page.locator(`.note[data-id="${FOREIGN}"] .text`);
      await foreign.locator('b').waitFor();
      // The allowed image has loaded or failed before the page is inspected, so a surviving handler would have run.
      await page.waitForFunction(
        (id) => [...document.querySelectorAll(`.note[data-id="${id}"] .text img`)].every((image) => image.complete),
        FOREIGN,
      );
      assert.equal(await page.evaluate(() => window.__xss), undefined);
      assert.equal(await foreign.locator('script, iframe, [onerror], [onclick], a[href^="javascript"]').count(), 0);
      assert.equal(await foreign.locator('b').innerText(), 'team');

      await page.locator('.addnote').first().click();
      const editor = page.locator('.modal-addnote [data-sim-note-editor][data-mounted="ready"]');
      await editor.waitFor();
      await editor
        .frameLocator('iframe.cke_wysiwyg_frame')
        .locator('body')
        .evaluate((body) => {
          body.innerHTML = '<p>Rich <strong>note</strong><img src="/missing.png" onerror="window.__xss=6"></p>';
          body.dispatchEvent(new Event('input', { bubbles: true }));
        });
      await page.locator('.modal-addnote .modal-footer .primary').click();
      await page.locator('.note .text strong').waitFor();
      const stored = app.store
        .snapshot()
        .tables.annotation.map((row) => row.notetext)
        .filter((text) => /Rich/.test(text));
      assert.deepEqual(stored, ['*WEB*<p>Rich <strong>note</strong><img src="/missing.png" /></p>']);
      assert.equal(await page.evaluate(() => window.__xss), undefined);

      // The author's own note opens in the edit dialog's editor with its HTML.
      const own = page.locator('.note', { has: page.locator('.text strong') });
      await own.locator('.edit-link').evaluate((link) => link.click());
      const edit = page.locator('.modal-editnote [data-sim-note-editor][data-mounted="ready"]');
      await edit.waitFor();
      await page.waitForFunction(() =>
        /<strong>note<\/strong>/.test(globalThis.CKEDITOR?.instances?.notescontrol_editnote_text_editor?.getData()),
      );
      assert.deepEqual(errors, []);
    });
  }
});

// @test-kind unproven: the timeline client renders the activity service's records (subject, type, sanitized description without inline images) and pages them with the notes pager; the card markup is a local model, not a capture.
test('the activity timeline renders sanitized activities and pages them', async (t) => {
  const js = await fs.readFile(new URL('../lib/entity-grid-compat.js', import.meta.url));
  const activities = [1, 2, 3].map((n) => ({
    Id: `activity-${n}`,
    EntityName: 'phonecall',
    ActivityTypeDisplay: 'Phone Call',
    Subject: `Call ${n} <b>`,
    // The page must not trust the service either: unsanitized markup is reduced client-side too.
    Description: `<p>Talked <em>${n}</em></p><img src="/inline.png"><script>window.__xss=${n}</script>`,
    CreatedOnDisplay: '2026-02-01T00:00:00Z',
    PostedByName: 'Agent',
  }));
  const requests = [];
  const { origin } = await loopbackServer(t, (req, res) => {
    if (req.url === '/grid.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(js);
    if (req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const input = JSON.parse(body);
        requests.push([req.url, input.page, input.pageSize]);
        const records = activities.slice((input.page - 1) * 2, input.page * 2);
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ Records: records, PageNumber: input.page, PageCount: 2, ItemCount: 3 }));
      });
      return;
    }
    return res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html>
      <div id="antiforgerytoken"><input name="__RequestVerificationToken" value="loopback-token" type="hidden"></div>
      <div class="entity-notes" data-bs-target='{"Id":"sample","LogicalName":"item"}' data-is-timeline="True" data-url-get="/_portal/site/EntityActivity/GetActivities" data-pagesize="2">
        <div class="notes"></div><div class="notes-empty"></div><div class="notes-loading"></div><div class="notes-pagination" data-pages="1" data-current-page="1"></div>
      </div><script src="/grid.js"></script>`);
  });
  const page = await browser.page(t);
  await page.goto(origin);
  const first = page.locator('.note.activity[data-id="activity-1"]');
  await first.waitFor();
  assert.equal(await page.locator('.note.activity').count(), 2);
  assert.equal(await first.locator('.subject').innerText(), 'Call 1 <b>');
  assert.equal(await first.locator('.activitytype').innerText(), 'Phone Call');
  assert.equal(await first.locator('.createdby').innerText(), 'Agent');
  assert.equal(await first.locator('.text').innerHTML(), '<p>Talked <em>1</em></p>');
  await page.locator('.notes-pagination').getByRole('button', { name: 'Next page' }).click();
  await page.locator('.note.activity[data-id="activity-3"]').waitFor();
  assert.equal(await page.locator('.note.activity').count(), 1);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await page.locator('.notes img, .notes script').count(), 0);
  assert.deepEqual(requests, [
    ['/_portal/site/EntityActivity/GetActivities', 1, 2],
    ['/_portal/site/EntityActivity/GetActivities', 2, 2],
  ]);
});
