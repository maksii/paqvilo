import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { createSimulator } from '../mirage/server.mjs';
import { inspectionFixture } from '../test/source-inspection-fixture.mjs';
import { createSourceInspector, inspectRenderedPage } from '../lense/source-inspection.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';

test('actual native list cells use the emitted exported view and column without borrowing an unknown view', async (t) => {
  const fx = inspectionFixture();
  let app, browser;
  t.after(async () => {
    await browser?.close();
    await app?.close();
    fx.cleanup();
  });
  await fs.mkdir(path.join(fx.portal, 'lists'), { recursive: true });
  await fs.writeFile(
    path.join(fx.portal, 'lists/Items.list.yml'),
    'adx_entitylistid: item-list\nadx_name: Item list\nadx_entityname: fx_widget\nadx_views: \'[{"ViewId":"item-view"}]\'',
  );
  await fs.mkdir(path.join(fx.solution, 'Entities/fx_widget/SavedQueries'), { recursive: true });
  await fs.writeFile(
    path.join(fx.solution, 'Entities/fx_widget/SavedQueries/items.xml'),
    '<savedquery><savedqueryid>item-view</savedqueryid><fetchxml><fetch><entity name="fx_widget"><attribute name="fx_title"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="fx_title" width="120"/></row></grid></layoutxml><LocalizedNames><LocalizedName description="Item view" languagecode="1033"/></LocalizedNames></savedquery>',
  );
  await fs.writeFile(
    path.join(fx.portal, 'web-templates/Main.webtemplate.source.html'),
    '<!doctype html><html><body>{% include "entity_list" key:"Item list" %}</body></html>',
  );
  app = await createSimulator({
    sourceDir: fx.portal,
    solutionRoots: [fx.solution],
    watch: false,
    sourceMaps: false,
    stateFile: path.join(fx.work, 'state.json'),
    initial: {
      version: 1,
      tables: { fx_widget: [{ fx_widgetid: '20000000-0000-4000-8000-000000000001', fx_title: 'PRIVATE_ROW_VALUE' }] },
      mappings: { fx_widget: { entitySet: 'fx_widgets', idColumn: 'fx_widgetid' } },
      permissions: [],
      settings: { permissionMode: 'permissive' },
      simulator: { mode: 'local', pageMode: 'local', identity: null, endpoints: [], live: {} },
    },
  });
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  const page = await browser.newPage();
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === app.url ? route.fallback() : route.abort(),
  );
  await page.goto(app.url);
  const cell = page.locator('.entity-grid td[data-attribute="fx_title"]');
  await cell.waitFor().catch(async (error) => {
    const diagnostic = await page.locator('body').innerText();
    throw new Error('Native list did not render: ' + diagnostic.slice(0, 500), { cause: error });
  });
  assert.equal(await page.locator('.entity-grid').getAttribute('data-selected-view'), 'item-view');
  const inspector = createSourceInspector({ sourceDir: fx.portal, mirageConfig: { solutionRoots: [fx.solution] } });
  const runtime = await (await page.request.get(app.url + '/_sim/api/page-resources?path=%2F')).json();
  const report = await inspector.enrich(runtime, await page.evaluate(inspectRenderedPage));
  const data = {
    origin: app.url,
    token: 'invented-native-list',
    sourceRevision: report.sourceRevision,
    mirageMode: true,
  };
  await page.evaluate(xrayUi, data);
  await page.evaluate(({ data, report }) => document.getElementById('paqvilo-xray').__px.update(data, report), {
    data,
    report,
  });
  const inspect = () =>
    page.evaluate(
      () =>
        document
          .getElementById('paqvilo-xray')
          .__px.identify(document.querySelector('.entity-grid td[data-attribute="fx_title"]')).evidence,
    );
  const current = await inspect();
  assert.equal(current.owner.status, 'exact');
  assert.equal(current.owner.component.key, 'column:fx_widget:fx_title');
  assert.equal(current.source.status, 'exact');
  assert.ok(current.source.refs.some((ref) => ref.componentKey === 'column:fx_widget:fx_title'));
  assert.ok(current.enclosing.some((item) => item.status === 'exact' && item.component.id === 'item-view'));
  assert.equal(JSON.stringify(current).includes('PRIVATE_ROW_VALUE'), false);
  await page.locator('.entity-grid').evaluate((node) => node.setAttribute('data-selected-view', 'unknown-view'));
  const unknown = await inspect();
  assert.notEqual(unknown.owner.status, 'exact', 'an unknown native view cannot borrow the sole exported list/view');
  assert.notEqual(unknown.source.status, 'exact');
  await page.locator('.entity-grid').evaluate((node) => node.setAttribute('data-selected-view', 'item-view'));
  await cell.evaluate((node) => node.closest('tr').setAttribute('data-entity', 'fx_unrelated'));
  assert.equal((await inspect()).owner.status, 'conflicting', 'row/view table disagreement remains a conflict');
});
