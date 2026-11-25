// @test-kind observation: Consumer report #257 observed rows="1" on two authored one-row cells in a Bootstrap 3 Power Pages Basic Form. The layout and save assertions use an invented loopback fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';
import { makeTemporaryDirectory, ownedFixture, removeFixtureDirectory } from '../testing/owned-fixture.mjs';
import { sharedBrowser } from './shared-browser.mjs';

const chrome = sharedBrowser();

test('Bootstrap 3 Basic Form honors an authored one-row textarea and saves multiline edits', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'basic-form-textarea-'));
  const fixture = ownedFixture(t);
  fixture.remove(() => removeFixtureDirectory(root));
  const columns = ['notes', 'longnotes', 'defaultnotes'];
  const files = {
    'portal/website.yml': 'adx_websiteid: site\nadx_name: Textarea fixture',
    'portal/web-pages/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/page-templates/Main.pagetemplate.yml':
      'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'portal/web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/web-templates/Main.webtemplate.source.html': `<style>
    .crmEntityFormView td textarea.form-control { box-sizing: border-box; height: auto; min-height: 0;
      line-height: 24px; padding: 8px 12px; border: 1px solid; }
    </style>{% entityform name: "Edit entry" %}`,
    'portal/basic-forms/Edit.basicform.yml':
      'adx_entityformid: edit\nadx_name: Edit entry\nadx_entityname: sample\nadx_formname: Entry\nadx_mode: 100000001\nadx_entitysourcetype: 756150001\nadx_recordidquerystringparametername: id\nadx_hideformonsuccess: false\nadx_successmessage: Entry saved',
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>TextareaFixture</UniqueName></SolutionManifest></ImportExportXml>',
    'solution/Entities/Sample/Entity.xml': `<Entity><Name>sample</Name><EntityInfo><entity><attributes>${columns
      .map((name) => `<attribute><LogicalName>${name}</LogicalName><Type>memo</Type></attribute>`)
      .join('')}</attributes></entity></EntityInfo></Entity>`,
    'solution/Entities/Sample/FormXml/main/Entry.xml': `<systemform><formid>entry</formid><form><tabs><tab name="main"><columns><column><sections><section name="notes" columns="11"><rows>
      <row><cell colspan="2" rowspan="1"><control datafieldname="notes"/></cell></row>
      <row><cell colspan="2" rowspan="3"><control datafieldname="longnotes"/></cell></row>
      <row/><row/>
      <row><cell colspan="2"><control datafieldname="defaultnotes"/></cell></row>
      </rows></section></sections></column></columns></tab></tabs></form><LocalizedNames><LocalizedName description="Entry" languagecode="1033"/></LocalizedNames></systemform>`,
  };
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, source);
  }
  const id = '10000000-0000-4000-8000-000000000001';
  const prior = '\nEarlier\nnotes';
  const app = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    solutionRoots: [path.join(root, 'solution')],
    port: 0,
    watch: false,
    initial: {
      mappings: { sample: { entitySet: 'samples', idColumn: 'sampleid' } },
      tables: { sample: [{ sampleid: id, notes: '', longnotes: prior, defaultnotes: prior }] },
      settings: { permissionMode: 'enforce' },
      permissions: [{ entity: 'sample', scope: 'global', roles: ['Editor'], operations: ['read', 'update'] }],
    },
  });
  fixture.add(() => app.close());
  const context = await chrome.browser.newContext({ viewport: { width: 1440, height: 1000 } });
  fixture.add(() => context.close());
  await signInContext(context, app, 'editor', { roles: ['Editor'] });
  const page = await context.newPage();
  await page.goto(`${app.url}/?id=${id}`);

  const notes = page.locator('textarea#notes');
  assert.equal(await notes.getAttribute('rows'), '1');
  assert.equal((await notes.boundingBox())?.height, 42);
  assert.equal(await notes.inputValue(), '');
  for (const [name, span, rows] of [
    ['longnotes', '3', '7'],
    ['defaultnotes', '1', '4'],
  ]) {
    const textarea = page.locator(`textarea#${name}`);
    assert.equal(await textarea.getAttribute('rows'), rows);
    assert.equal(await textarea.locator('xpath=ancestor::td').getAttribute('rowspan'), span);
    assert.equal(await textarea.inputValue(), prior);
  }

  const edited = '\nUpdated\nnotes';
  await notes.fill(edited);
  const [response] = await Promise.all([
    page.waitForResponse((item) => item.request().isNavigationRequest() && item.request().method() === 'POST'),
    page.locator('#UpdateButton').click(),
  ]);
  assert.equal(response.status(), 200);
  await page.locator('#MessageLabel').waitFor();
  assert.equal(await notes.inputValue(), edited);
  assert.equal(await notes.getAttribute('rows'), '1');
  assert.equal((await notes.boundingBox())?.height, 42);
  const [stored] = app.store.snapshot().tables.sample;
  assert.equal(stored.notes, edited);
  assert.equal(stored.longnotes, prior);
  assert.equal(stored.defaultnotes, prior);

  const modal = await page.goto(
    `${app.url}/_portal/modal-form-template-path/00000000-0000-0000-0000-000000000000/?entityformid=edit&id=${id}`,
  );
  assert.equal(modal?.status(), 200);
  assert.equal(await notes.getAttribute('rows'), '1');
  assert.equal(await notes.inputValue(), edited);
  // The standalone modal does not include the authored page's textarea styles.
  assert.equal(await notes.evaluate((node) => getComputedStyle(node).minHeight), '34px');
  assert.ok((await notes.boundingBox()).height < 80);
  for (const name of ['longnotes', 'defaultnotes']) {
    const textarea = page.locator(`textarea#${name}`);
    assert.equal(await textarea.evaluate((node) => getComputedStyle(node).minHeight), '80px');
    assert.ok((await textarea.boundingBox()).height >= 80);
  }
});
