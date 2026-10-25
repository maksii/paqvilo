import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { createSimulator } from '../mirage/server.mjs';
import { createSourceInspector, inspectRenderedPage } from '../lense/source-inspection.mjs';
import { createPortalProvenanceTransport } from '../lense/portal-provenance-transport.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';
import { editSource } from '../lense/source-edit.mjs';
import { inspectionFixture } from '../test/source-inspection-fixture.mjs';

test('native progress proves the actual localized step label, opens that field from UI and stales old links after reordering', async () => {
  const fx = inspectionFixture();
  let app, browser, context, attached;
  try {
    fs.appendFileSync(path.join(fx.portal, 'website.yml'), '\nadx_defaultlanguage: en\n');
    fs.writeFileSync(
      path.join(fx.portal, 'websitelanguage.yml'),
      YAML.stringify([
        { adx_websitelanguageid: 'en', adx_name: 'English', adx_languagecode: 'en-US', adx_lcid: 1033 },
        { adx_websitelanguageid: 'fr', adx_name: 'French', adx_languagecode: 'fr-FR', adx_lcid: 1036 },
        { adx_websitelanguageid: 'es', adx_name: 'Spanish', adx_languagecode: 'es-ES', adx_lcid: 3082 },
      ]),
    );
    fs.writeFileSync(
      path.join(fx.portal, 'sitesetting.yml'),
      'adx_sitesettingid: display-language\nadx_name: MultiLanguage/DisplayLanguageCodeInURL\nadx_value: "true"',
    );
    const directory = path.join(fx.portal, 'advanced-forms');
    fs.mkdirSync(directory);
    fs.writeFileSync(
      path.join(directory, 'Wizard.advancedform.yml'),
      YAML.stringify({
        adx_webformid: 'wizard',
        adx_name: 'Wizard',
        adx_startstep: 'step',
        adx_progressindicatorenabled: true,
        adx_progressindicatorprependstepnum: true,
        adx_progressindicatorposition: 756150001,
      }),
    );
    const file = path.join(directory, 'Step.advancedformstep.yml');
    fs.writeFileSync(
      file,
      YAML.stringify({
        adx_webformstepid: 'step',
        adx_name: 'Step',
        adx_webform: 'wizard',
        adx_entityname: 'fx_widget',
        adx_formname: 'Widget form',
        adx_formid: 'widget-form',
        adx_type: 100000001,
        adx_mode: 100000000,
        adx_title: JSON.stringify([
          { LCID: 1036, Value: '<h3 id="invented-title">French</h3>' },
          { LCID: 1033, Value: '<h3 id="invented-title">English</h3>' },
        ]),
      }),
    );
    fs.writeFileSync(
      path.join(fx.portal, 'web-templates/Partial.webtemplate.source.html'),
      '{% webform name:"Wizard" %}<li id="lookalike" class="list-group-item active">Unrelated authored list item</li>',
    );
    app = await createSimulator({
      sourceDir: fx.portal,
      solutionRoots: [fx.solution],
      stateFile: path.join(fx.work, 'state.json'),
      watch: false,
      sourceMaps: false,
      initial: {
        version: 1,
        tables: { fx_widget: [] },
        mappings: { fx_widget: { entitySet: 'fx_widgets', idColumn: 'fx_widgetid' } },
        permissions: [],
        settings: { permissionMode: 'permissive' },
        simulator: { mode: 'local', pageMode: 'local', identity: null, endpoints: [], live: {} },
      },
    });
    browser = await chromium.launch(
      browserLaunchOptions({ headless: true, args: ['--disable-background-networking'] }),
    );
    context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage(),
      cdp = await context.newCDPSession(page),
      transport = createPortalProvenanceTransport(context, [{ origin: app.url, mirage: true }]);
    attached = await transport.onAttach({ cdp, configure: (method, params) => cdp.send(method, params) });
    await cdp.send('Network.enable');
    const inspector = createSourceInspector({ sourceDir: fx.portal, mirageConfig: { solutionRoots: [fx.solution] } });
    const load = async (route) => {
      await page.goto(app.url + route);
      await page.waitForFunction(
        (slot) =>
          window[slot]
            ?.query(document.querySelector('ol.progress li.active'), {
              scope: { documentId: 'actual-document', frameId: 'top', uiEpoch: 1, sourceRevision: 'pending' },
            })
            ?.facts.some((fact) => fact.kind === 'render-platform'),
        transport.slot,
      );
      const runtime = await (
          await context.request.get(app.url + '/_sim/api/page-resources?path=' + encodeURIComponent(route))
        ).json(),
        rendered = await page.evaluate(inspectRenderedPage),
        report = await inspector.enrich(runtime, rendered);
      const data = {
        origin: app.url,
        token: 'invented-progress',
        mirageMode: true,
        sourceRevision: report.sourceRevision,
        provenanceSlot: transport.slot,
      };
      await page.evaluate(xrayUi, data);
      await page.evaluate(
        ({ data, report }) => {
          const api = document.getElementById('paqvilo-xray').__px;
          api.update(data, report);
          api.toggle(true);
          api.select(document.querySelector('ol.progress li.active'));
        },
        { data, report },
      );
      return { report, runtime, rendered, data };
    };
    const read = (selector) =>
      page.evaluate(
        (selector) => document.getElementById('paqvilo-xray').__px.identify(document.querySelector(selector)).evidence,
        selector,
      );
    await load('/fr-FR/');
    assert.equal(
      await page.locator('#invented-title').count(),
      0,
      'a label string is escaped, not interpreted as authored HTML',
    );
    let evidence = await read('ol.progress li.active');
    assert.equal(evidence.owner.status, 'exact');
    assert.equal(evidence.owner.component.key, 'advanced-form-step:step');
    assert.equal(evidence.source.status, 'exact');
    assert.ok(
      evidence.source.refs.some(
        (ref) =>
          ref.recordId === 'step' && ref.fieldPath?.[0] === 'title' && ref.lcid === 1036 && ref.status === 'exact',
      ),
    );
    assert.notEqual(
      (await read('#lookalike')).owner.status,
      'exact',
      'matching CSS classes cannot fabricate a platform step',
    );
    assert.notEqual(
      (await read('ol.progress .number')).owner.status,
      'exact',
      'generated numerical chrome is not the selected step definition',
    );
    const current = await load('/es-ES/');
    evidence = await read('ol.progress li.active');
    const source = evidence.source.refs.find(
      (ref) => ref.recordId === 'step' && ref.fieldPath?.[0] === 'title' && ref.status === 'exact',
    );
    assert.equal(
      source.lcid,
      1033,
      'missing Spanish label uses the website default English value, not the first French array entry',
    );
    const action = page.evaluate(
      () =>
        new Promise((resolve) => {
          const listener = (event) => {
            if (event.detail?.action === 'open') {
              document.removeEventListener('paqvilo-xray', listener);
              resolve(event.detail);
            }
          };
          document.addEventListener('paqvilo-xray', listener);
        }),
    );
    await page
      .locator('#paqvilo-xray')
      .locator('.ie-row')
      .filter({ hasText: 'Field: title' })
      .getByRole('button', { name: 'Open source', exact: true })
      .click();
    const body = { ...(await action), route: '/es-ES/' };
    const opening = await inspector.lookupSource(body);
    assert.equal(opening.state, 'exact');
    assert.equal(opening.sourceRef.lcid, 1033);
    assert.deepEqual(opening.sourceRef.jsonPath, [1, 'Value']);
    assert.equal(opening.editorTarget.file, file);
    assert.equal(opening.editorTarget.container, true);
    editSource(
      {
        file,
        format: 'yaml',
        field: 'adx_title',
        fieldPath: ['adx_title'],
        recordId: 'step',
        recordIdField: 'adx_webformstepid',
      },
      (value) => JSON.stringify(JSON.parse(value).reverse()),
    );
    assert.equal((await inspector.lookupSource(body)).state, 'stale');
    const index = await inspector.sourceIndexFor('/es-ES/'),
      reordered = index.source({ id: 'step' }, 'title', { lcid: 1033 });
    assert.equal(reordered.key, source.key);
    assert.equal(reordered.contentRevision, source.contentRevision);
    assert.deepEqual(reordered.jsonPath, [0, 'Value']);
    assert.equal(
      (
        await inspector.lookupSource({
          ...body,
          sourceRevision: reordered.sourceRevision,
          contentRevision: reordered.contentRevision,
        })
      ).state,
      'exact',
    );
    const report = await inspector.enrich(current.runtime, current.rendered);
    await page.evaluate(
      ({ data, report }) => {
        const api = document.getElementById('paqvilo-xray').__px;
        api.update({ ...data, sourceRevision: report.sourceRevision }, report);
        api.select(document.querySelector('ol.progress li.active'));
      },
      { data: current.data, report },
    );
    evidence = await read('ol.progress li.active');
    assert.equal(evidence.owner.status, 'exact');
    assert.equal(
      evidence.source.status,
      'stale',
      'current configuration cannot relabel an old rendered source snapshot',
    );
  } finally {
    await attached?.dispose();
    await context?.close();
    await browser?.close();
    await app?.close();
    fx.cleanup();
  }
});
