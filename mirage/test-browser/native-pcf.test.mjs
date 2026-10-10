import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';

test('explicit portal metadata activates exported form-bound PCF and saves through the native form', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-pcf-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const portal = path.join(root, 'portal'), solution = path.join(root, 'solution');
  const files = {
    'portal/website.yml': 'adx_websiteid: site\nadx_name: Synthetic native PCF',
    'portal/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html': '{% entityform name:"Create row" %}',
    'portal/Row.basicform.yml': 'adx_entityformid: row-basic\nadx_name: Create row\nadx_entityname: tst_row\nadx_formname: Portal row\nadx_mode: 100000000',
    'portal/Row.basicform.basicformmetadata.yml': 'adx_entityformmetadataid: native-component\nadx_entityform: row-basic\nadx_type: 100000000\nadx_attributelogicalname: tst_title\nadx_controlstyle: 756150001',
    'solution/Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>Synthetic</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/tst_Row/Entity.xml': '<Entity><Name>tst_row</Name><EntityInfo><entity><attributes><attribute PhysicalName="tst_title"><Name>tst_title</Name><LogicalName>tst_title</LogicalName><Type>nvarchar</Type><RequiredLevel>required</RequiredLevel></attribute></attributes></entity></EntityInfo></Entity>',
    'solution/Entities/tst_Row/FormXml/main/row-form.xml': '<forms><systemform><formid>{row-form}</formid><FormActivationState>1</FormActivationState><form><tabs><tab name="general"><columns><column><sections><section name="main"><rows><row><cell><labels><label description="Title" languagecode="1033"/></labels><control id="tst_title" uniqueid="field-control" datafieldname="tst_title"/></cell></row></rows></section></sections></column></columns></tab></tabs><controlDescriptions><controlDescription forControl="field-control"><customControl name="tst_Synthetic.Editor" formFactor="0"><parameters><value type="SingleLine.Text">tst_title</value><caption static="true" type="SingleLine.Text">Portal editor</caption></parameters></customControl></controlDescription></controlDescriptions></form><LocalizedNames><LocalizedName description="Portal row" languagecode="1033"/></LocalizedNames></systemform></forms>',
    'solution/Controls/tst_Synthetic.Editor/ControlManifest.xml': '<manifest><control namespace="Synthetic" constructor="Editor" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="bound"/><property name="caption" of-type="SingleLine.Text" usage="input"/><resources><code path="bundle.js"/></resources></control></manifest>',
    'solution/Controls/tst_Synthetic.Editor/ControlManifest.xml.data.xml': '<CustomControl><Name>tst_Synthetic.Editor</Name></CustomControl>',
    'solution/Controls/tst_Synthetic.Editor/bundle.js': `ComponentFramework.registerControl('Synthetic.Editor',class{init(c,notify,_s,el){this.input=document.createElement('input');this.input.setAttribute('aria-label',c.parameters.caption.raw);this.input.disabled=c.mode.isControlDisabled;this.input.value=c.parameters.value.raw||'';this.input.addEventListener('input',notify);el.append(this.input);}updateView(){}getOutputs(){return{value:this.input.value};}destroy(){}});`,
  };
  for (const [name, content] of Object.entries(files)) { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); }
  const app = await createSimulator({ sourceDir: portal, solutionRoots: [solution], port: 0, watch: false, initial: {
    version: 1, mappings: { tst_row: { entitySet: 'tst_rows', idColumn: 'tst_rowid', nameColumn: 'tst_title' } }, tables: { tst_row: [] }, permissions: [], settings: { permissionMode: 'permissive' }, simulator: { mode: 'local', pageMode: 'local', identity: { id: 'editor', roles: ['Editor'] }, endpoints: [], live: { origin: null }, componentSchemas: {} },
  } });
  t.after(() => app.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true })); t.after(() => browser.close());
  const context = await browser.newContext(); await signInContext(context, app, 'editor', { roles: ['Editor'] });
  const page = await context.newPage(), errors = [], external = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(app.url)) external.push(request.url()); });
  await page.goto(app.url);
  assert.match(await page.content(), /data-pcf-schema=/, JSON.stringify(app.state().diagnostics));
  await page.locator('[data-pcf-ready=true]').waitFor();
  assert.equal(await page.locator('#tst_title').isVisible(), false);
  await page.getByLabel('Portal editor').fill('Saved by PCF');
  assert.equal(await page.locator('#tst_title').inputValue(), 'Saved by PCF');
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await page.locator('#MessageLabel').filter({ hasText: 'Submission completed successfully.' }).waitFor();
  assert.equal(app.store.snapshot().tables.tst_row[0].tst_title, 'Saved by PCF');
  await page.goto('about:blank');
  // Removing the explicit portal flag retains the ordinary field despite FormXml defaults.
  await fs.writeFile(path.join(portal, 'Row.basicform.basicformmetadata.yml'), files['portal/Row.basicform.basicformmetadata.yml'].replace('756150001', '100000000'));
  await app.reload(); await page.goto(app.url);
  assert.equal(await page.locator('[data-pcf-schema]').count(), 0);
  assert.equal(await page.locator('#tst_title').isVisible(), true);
  await page.goto('about:blank');
  // An enabled control whose solution binding is absent produces a diagnostic and native fallback.
  await fs.writeFile(path.join(portal, 'Row.basicform.basicformmetadata.yml'), files['portal/Row.basicform.basicformmetadata.yml']);
  await fs.writeFile(path.join(solution, 'Entities/tst_Row/FormXml/main/row-form.xml'), files['solution/Entities/tst_Row/FormXml/main/row-form.xml'].replace('tst_Synthetic.Editor', 'tst_Missing.Editor'));
  await app.reload(); await page.goto(app.url);
  assert.match(await page.locator('[data-mirage-component="codecomponent"]').innerText(), /not found/);
  assert.equal(await page.locator('#tst_title').isVisible(), true);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});
