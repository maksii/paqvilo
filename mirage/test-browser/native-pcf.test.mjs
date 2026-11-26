// @test-kind contract: Mirage mounts and saves qualified native PCF bindings on a loopback portal
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { rowsDatasetControl, writeFixtureFiles } from '../test/support/pcf-fixture-files.mjs';
import { editorPage, localEditorState } from './native-pcf-fixture.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

test('explicit portal metadata activates exported form-bound PCF and saves through the native form', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'native-pcf-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const portal = path.join(root, 'portal'),
    solution = path.join(root, 'solution');
  const files = {
    'portal/website.yml': 'adx_websiteid: site\nadx_name: Synthetic native PCF',
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml':
      'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html': '{% entityform name:"Create row" %}',
    'portal/Row.basicform.yml':
      'adx_entityformid: row-basic\nadx_name: Create row\nadx_entityname: tst_row\nadx_formname: Portal row\nadx_mode: 100000000',
    'portal/Row.basicform.basicformmetadata.yml':
      'adx_entityformmetadataid: native-component\nadx_entityform: row-basic\nadx_type: 100000000\nadx_attributelogicalname: tst_title\nadx_controlstyle: 756150001',
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>Synthetic</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/tst_Row/Entity.xml':
      '<Entity><Name>tst_row</Name><EntityInfo><entity><attributes><attribute PhysicalName="tst_title"><Name>tst_title</Name><LogicalName>tst_title</LogicalName><Type>nvarchar</Type><RequiredLevel>required</RequiredLevel><MaxLength>72</MaxLength><Format>text</Format></attribute></attributes></entity></EntityInfo></Entity>',
    'solution/Entities/tst_Row/FormXml/main/row-form.xml':
      '<forms><systemform><formid>{row-form}</formid><FormActivationState>1</FormActivationState><form><tabs><tab name="general"><columns><column><sections><section name="main"><rows><row><cell><labels><label description="Title" languagecode="1033"/></labels><control id="tst_title" uniqueid="field-control" datafieldname="tst_title"/></cell></row></rows></section></sections></column></columns></tab></tabs><controlDescriptions><controlDescription forControl="field-control"><customControl name="tst_Synthetic.Editor" formFactor="0"><parameters><value type="SingleLine.Text">tst_title</value><caption static="true" type="SingleLine.Text">Portal editor</caption></parameters></customControl></controlDescription></controlDescriptions></form><LocalizedNames><LocalizedName description="Portal row" languagecode="1033"/></LocalizedNames></systemform></forms>',
    'solution/Controls/tst_Synthetic.Editor/ControlManifest.xml':
      '<manifest><control namespace="Synthetic" constructor="Editor" control-type="standard"><type-group name="Mixed"><type>SingleLine.Text</type><type>DateAndTime.DateOnly</type></type-group><property name="value" of-type-group="Mixed" usage="bound"/><property name="caption" of-type="SingleLine.Text" usage="input"/><resources><code path="bundle.js"/></resources></control></manifest>',
    'solution/Controls/tst_Synthetic.Editor/ControlManifest.xml.data.xml':
      '<CustomControl><Name>tst_Synthetic.Editor</Name></CustomControl>',
    'solution/Controls/tst_Synthetic.Editor/bundle.js': `/*! Synthetic compiled SDK module */ var synthetic_sdk_exports;(()=>{class Editor{init(c,notify,_s,el){window.nativePcfAttributes=c.parameters.value.attributes;this.input=document.createElement('input');this.input.setAttribute('aria-label',c.parameters.caption.raw);this.input.disabled=c.mode.isControlDisabled;this.input.value=c.parameters.value.raw||'';this.input.addEventListener('input',notify);el.append(this.input);}updateView(){}getOutputs(){return{value:this.input.value};}destroy(){}}synthetic_sdk_exports={};Object.defineProperty(synthetic_sdk_exports,'Editor',{enumerable:true,get:()=>Editor});})();`,
  };
  await writeFixtureFiles(root, files);
  const app = await createSimulator({
    sourceDir: portal,
    solutionRoots: [solution],
    port: 0,
    watch: false,
    initial: localEditorState(
      { tst_row: { entitySet: 'tst_rows', idColumn: 'tst_rowid', nameColumn: 'tst_title' } },
      { tst_row: [] },
    ),
  });
  ownedFixture(t).add(() => app.close());
  const page = await editorPage(t, app),
    errors = [],
    external = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith(app.url)) external.push(request.url());
  });
  await page.goto(app.url);
  assert.match(await page.content(), /data-pcf-schema=/, JSON.stringify(app.state().diagnostics));
  await page.locator('[data-pcf-ready=true]').waitFor();
  assert.equal(await page.evaluate(() => window.__paqviloPcf.inspect()[0].parameters.value.type), 'SingleLine.Text');
  // The field host names the column and the property, RequiredLevel 0 and the column's length up to 100 (captured,
  // paqvilo-developer pcf-parity capture f1|f2 edit-full).
  const attributes = await page.evaluate(() => window.nativePcfAttributes);
  assert.deepEqual(
    [attributes.DisplayName, attributes.LogicalName, attributes.RequiredLevel, attributes.MaxLength, attributes.Format],
    ['value', 'tst_title', 0, 72, 'Text'],
  );
  // The field host renders no native box: the value lives in the hidden input.
  assert.equal(await page.locator('input[type=hidden]#tst_title').count(), 1);
  await page.getByLabel('Portal editor').fill('Saved by PCF');
  await page.waitForFunction(() => document.getElementById('tst_title').value === '"Saved by PCF"');
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await page.locator('#MessageLabel').filter({ hasText: 'Submission completed successfully.' }).waitFor();
  assert.equal(app.store.snapshot().tables.tst_row[0].tst_title, 'Saved by PCF');
  await page.goto('about:blank');
  // Removing the explicit portal flag retains the ordinary field despite FormXml defaults.
  await fs.writeFile(
    path.join(portal, 'Row.basicform.basicformmetadata.yml'),
    files['portal/Row.basicform.basicformmetadata.yml'].replace('756150001', '100000000'),
  );
  await app.reload();
  await page.goto(app.url);
  assert.equal(await page.locator('[data-pcf-schema]').count(), 0);
  assert.equal(await page.locator('#tst_title').isVisible(), true);
  await page.goto('about:blank');
  // An enabled control whose solution binding is absent produces a diagnostic and native fallback.
  await fs.writeFile(
    path.join(portal, 'Row.basicform.basicformmetadata.yml'),
    files['portal/Row.basicform.basicformmetadata.yml'],
  );
  await fs.writeFile(
    path.join(solution, 'Entities/tst_Row/FormXml/main/row-form.xml'),
    files['solution/Entities/tst_Row/FormXml/main/row-form.xml'].replace('tst_Synthetic.Editor', 'tst_Missing.Editor'),
  );
  await app.reload();
  await page.goto(app.url);
  assert.match(await page.locator('[data-mirage-component="codecomponent"]').innerText(), /not found/);
  assert.equal(await page.locator('#tst_title').isVisible(), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});

// @test-kind contract+observation: native list and FormXml PCF dataset bindings retain the exported view and parent relationship; no record navigation and grid-service rows per live capture paqvilo-developer pcf-parity summary-C (Q-041, Data transport)
test('explicit native dataset PCF bindings load the view and keep the subgrid restricted to its parent', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'native-dataset-pcf-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const view = 'b0000000-0000-4000-8000-000000000001';
  const parent = 'c0000000-0000-4000-8000-000000000001';
  const sibling = 'c0000000-0000-4000-8000-000000000002';
  const entity =
    '<attribute PhysicalName="tst_title"><Name>tst_title</Name><LogicalName>tst_title</LogicalName><Type>nvarchar</Type></attribute>';
  const files = {
    'portal/website.yml': 'adx_websiteid: site\nadx_name: Dataset site',
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html':
      "{% include 'entity_list' key:'All rows' %}{% entityform name:'Parent form' %}",
    'portal/Details.webpage.yml':
      'adx_webpageid: details\nadx_name: Details\nadx_partialurl: details\nadx_isroot: true',
    'portal/Rows.list.yml': `adx_entitylistid: rows\nadx_name: All rows\nadx_entityname: tst_row\nadx_view: ${view}\nadx_iscodecomponent: true\nadx_webpagefordetailsview: details\nadx_idquerystringparametername: selected`,
    'portal/Parent.basicform.yml':
      'adx_entityformid: parent-basic\nadx_name: Parent form\nadx_entityname: tst_parent\nadx_formname: Parent\nadx_mode: 100000001',
    'portal/Parent.basicform.basicformmetadata.yml':
      'adx_entityformmetadataid: parent-subgrid\nadx_entityform: parent-basic\nadx_type: 100000003\nadx_subgrid_name: children\nadx_controlstyle: 756150001',
    'portal/sitesetting.yml':
      '- adx_sitesettingid: enabled\n  adx_name: Webapi/tst_row/enabled\n  adx_value: true\n- adx_sitesettingid: columns\n  adx_name: Webapi/tst_row/fields\n  adx_value: tst_rowid,tst_title,tst_parentid',
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>Synthetic</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/tst_row/Entity.xml': `<Entity><Name>tst_row</Name><EntityInfo><entity><attributes>${entity}<attribute PhysicalName="tst_parentid"><Name>tst_parentid</Name><LogicalName>tst_parentid</LogicalName><Type>lookup</Type></attribute></attributes></entity></EntityInfo><CustomControlDefaultConfigs><CustomControlDefaultConfig><CustomControlDefaultConfigXml><customControl name="tst_Synthetic.Rows" formFactor="0"/></CustomControlDefaultConfigXml></CustomControlDefaultConfig></CustomControlDefaultConfigs></Entity>`,
    'solution/Entities/tst_parent/Entity.xml': `<Entity><Name>tst_parent</Name><EntityInfo><entity><attributes>${entity}</attributes></entity></EntityInfo></Entity>`,
    'solution/Entities/tst_parent/FormXml/main/parent-form.xml': `<systemform><formid>{parent-form}</formid><type>2</type><LocalizedNames><LocalizedName description="Parent" languagecode="1033"/></LocalizedNames><form><tabs><tab name="general"><columns><column><sections><section name="main"><rows><row><cell><control id="children" indicationOfSubgrid="true"><parameters><TargetEntityType>tst_row</TargetEntityType><ViewId>${view}</ViewId><RelationshipName>tst_related_rows</RelationshipName></parameters></control></cell></row></rows></section></sections></column></columns></tab></tabs><controlDescriptions><controlDescription forControl="children"><customControl name="tst_Synthetic.Rows" formFactor="0"><parameters><data-set name="records"><ViewId>${view}</ViewId><TargetEntityType>tst_row</TargetEntityType></data-set></parameters></customControl></controlDescription></controlDescriptions></form></systemform>`,
    [`solution/Entities/tst_row/SavedQueries/${view}.xml`]: `<savedquery><savedqueryid>${view}</savedqueryid><LocalizedNames><LocalizedName description="Fixture rows" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="tst_row"><attribute name="tst_rowid"/><attribute name="tst_title"/><order attribute="tst_title"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="tst_title" width="200"/></row></grid></layoutxml></savedquery>`,
    ...rowsDatasetControl(
      "ComponentFramework.registerControl('Synthetic.Rows',class{init(_c,_n,_s,el){this.output=document.createElement('p');this.output.className='fixture-records';el.append(this.output);}updateView(c){const ds=c.parameters.records;this.output.fixtureDataset=ds;this.output.textContent=ds.errorMessage||ds.sortedRecordIds.map(id=>ds.records[id].getValue('tst_title')).join(',');}});",
    ),
  };
  await writeFixtureFiles(root, files);
  const app = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    solutionRoots: [path.join(root, 'solution')],
    watch: false,
    initial: {
      tables: {
        tst_parent: [parent, sibling].map((tst_parentid) => ({ tst_parentid })),
        tst_row: [parent, sibling].map((id, index) => ({
          tst_rowid: 'd0000000-0000-4000-8000-00000000000' + (index + 1),
          tst_title: index ? 'Sibling row' : 'Related row',
          tst_parentid: { id, logical_name: 'tst_parent' },
        })),
      },
      mappings: {
        tst_parent: {
          entitySet: 'tst_parents',
          idColumn: 'tst_parentid',
          relationships: {
            tst_related_rows: { entity: 'tst_row', from: 'tst_parentid', to: 'tst_parentid', many: true },
          },
        },
        tst_row: {
          entitySet: 'tst_rows',
          idColumn: 'tst_rowid',
          nameColumn: 'tst_title',
          relationships: {
            tst_parent: { entity: 'tst_parent', from: 'tst_parentid', to: 'tst_parentid', many: false },
          },
        },
      },
      settings: { permissionMode: 'permissive' },
    },
  });
  ownedFixture(t).add(() => app.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const page = await browser.newPage();
  const url = `${app.url}/?id=${parent}`;
  await page.goto(url);
  assert.equal(await page.locator('[data-pcf-schema]').count(), 2, JSON.stringify(app.state().diagnostics));
  await page.locator('.fixture-records', { hasText: 'Related row,Sibling row' }).waitFor({ timeout: 5000 });
  await page
    .locator('.fixture-records')
    .filter({ hasText: /^Related row$/ })
    .waitFor({ timeout: 5000 });
  assert.deepEqual(await page.locator('.fixture-records').allTextContents(), [
    'Related row,Sibling row',
    'Related row',
  ]);

  // Live Power Pages returns undefined and stays on the page, although the list has a details page (W6 packet 04:
  // capture paqvilo-developer pcf-parity summary-C, Q-041); this replaced the
  // checkpoint's details navigation.
  const opened = await page
    .locator('.fixture-records')
    .first()
    .evaluate((node) => {
      const dataset = node.fixtureDataset;
      return dataset.openDatasetItem(dataset.records[dataset.sortedRecordIds[0]].getNamedReference()) === undefined;
    });
  assert.equal(opened, true);
  assert.equal(new URL(page.url()).pathname, '/');

  // The data sets read through the grid services, not the portal Web API: disabling the table's Web API leaves both
  // components mounted with their rows (summary-C, Data transport).
  // The open page reloads itself on the runtime's reload event, which would race (and abort) the next navigation.
  await page.goto('about:blank');
  const settingsPath = 'portal/sitesetting.yml';
  await fs.writeFile(path.join(root, settingsPath), files[settingsPath].replace('adx_value: true', 'adx_value: false'));
  await app.reload();
  await page.goto(url);
  assert.equal(await page.locator('[data-pcf-schema]').count(), 2);
  await page
    .locator('.fixture-records')
    .filter({ hasText: /^Related row$/ })
    .waitFor({ timeout: 5000 });
  assert.equal(await page.locator('[data-mirage-component="codecomponent"][role=alert]').count(), 0);
});
