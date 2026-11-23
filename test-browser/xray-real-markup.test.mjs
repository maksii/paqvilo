// @test-kind contract: X-ray passes the page's configured components to the portal observation, keeps column candidates to rendered table context, survives named form controls and leaves frames untouched until their first document commits
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

const origin = 'http://127.0.0.1:11894';
const FORM_ID = 'a1b2c3d4-0000-4000-8000-00000000f001';

// The root path serves the fixture; other paths are answered by `routes` (path -> handler) or a plain document.
async function xrayPage(t, html, report, { routes = {}, initScript } = {}) {
  const context = await browser.newContext();
  ownedFixture(t).add(() => context.close());
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  await page.route(origin + '/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (routes[path]) return routes[path](route);
    return route.fulfill({
      contentType: 'text/html',
      body: path === '/' ? '<!doctype html>' + html : '<!doctype html><p>Frame</p>',
    });
  });
  await page.goto(origin + '/');
  const data = { origin, token: 'invented-real-markup' };
  await page.evaluate(xrayUi, data);
  await page.evaluate(
    ({ data, report }) => {
      const api = document.getElementById('paqvilo-xray').__px;
      api.update(data, report);
      api.toggle(true);
    },
    { data, report },
  );
  return page;
}

// @test-kind observation: the generic #EntityFormControl wrapper and all-zero layout Id of a page-bound basic form were observed in raw server HTML of a live demo portal page bound to a basic form (2026-11-22); names invented
test("X-ray resolves a generic form wrapper to the basic form the report's web page names", async (t) => {
  const html =
    '<div id="EntityFormControl"><div id="EntityFormPanel" class="crmEntityFormView"><div id="EntityFormControl_EntityFormView" class="entity-form">' +
    '<span data-form-layout=\'{"EntityName":"sample_entry","Id":"00000000-0000-0000-0000-000000000000"}\'></span>' +
    '<table class="section" data-name="main_section"><tbody><tr><td class="cell"><div class="control" data-logical-name="sample_title"><input id="sample_title"></div></td></tr></tbody></table>' +
    '</div></div></div>';
  const report = {
    page: { id: 'invented-page', name: 'Invented page', entityFormId: FORM_ID },
    forms: [{ id: FORM_ID, kind: 'basic-form', entity: 'sample_entry', name: 'Invented entry form' }],
    columns: [{ entity: 'sample_entry', name: 'sample_title' }],
  };
  const page = await xrayPage(t, html, report);
  const identity = await page.evaluate(() => {
    const api = document.getElementById('paqvilo-xray').__px;
    const read = (selector) => api.identify(document.querySelector(selector)).evidence;
    const wrapper = read('#EntityFormControl'),
      input = read('#sample_title');
    return {
      wrapper: [wrapper.owner.status, wrapper.owner.component?.key, wrapper.owner.evidence?.[0]?.kind],
      input: [input.owner.status, input.owner.component?.key],
      enclosing: input.enclosing.map((row) => [row.status, row.component?.key]),
    };
  });
  assert.deepEqual(identity.wrapper, ['exact', 'basic-form:' + FORM_ID, 'page-configured-component']);
  assert.deepEqual(identity.input, ['exact', 'column:sample_entry:sample_title']);
  assert.ok(identity.enclosing.some(([status, key]) => status === 'exact' && key === 'basic-form:' + FORM_ID));
});

test('a hand-written input is not a candidate column of every table, and a display label is not a column name', async (t) => {
  const html =
    '<input id="sample_title"><table><tbody><tr><td data-th="sample_title" id="labelled-cell">Value</td></tr></tbody></table>';
  const report = {
    columns: [
      { entity: 'sample_entry', name: 'sample_title' },
      { entity: 'sample_other', name: 'sample_title' },
    ],
  };
  const page = await xrayPage(t, html, report);
  const found = await page.evaluate(() => {
    const api = document.getElementById('paqvilo-xray').__px;
    return ['#sample_title', '#labelled-cell'].map((selector) => {
      const row = api.identify(document.querySelector(selector));
      return {
        fields: row.b.fields.map((field) => field.entity + '.' + field.name),
        candidates: row.evidence.candidates.map((item) => item.component?.key),
      };
    });
  });
  assert.deepEqual(found, [
    { fields: [], candidates: [] },
    { fields: [], candidates: [] },
  ]);
});

test('selecting inside a form that has a control named "id" moves the card to the new element', async (t) => {
  // A form's id property is its control named "id" (named access), not its id attribute.
  const html =
    '<button id="first">First</button><form id="content_form" method="post"><input type="hidden" name="id" value="invented"><input id="target"></form>';
  const page = await xrayPage(t, html, { columns: [], forms: [] });
  const titles = await page.evaluate(() => {
    const api = document.getElementById('paqvilo-xray').__px;
    api.select(document.getElementById('first'));
    const first = api.selection()?.title;
    api.select(document.getElementById('target'));
    return [first, api.selection()?.title, api.selectedNode()?.id];
  });
  assert.deepEqual(titles, ['button element', 'input element', 'target']);
});

test("X-ray leaves a frame's window alone until its first document has committed, then reads it", async (t) => {
  // The frame's response waits for the test: X-ray sees the inserted frame before its document commits.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let requested;
  const arrived = new Promise((resolve) => (requested = resolve));
  const page = await xrayPage(
    t,
    '<p id="host">Host</p>',
    { columns: [] },
    {
      routes: {
        '/frame': async (route) => {
          requested();
          await held;
          await route.fulfill({ contentType: 'text/html', body: '<!doctype html><p id="inner">Frame</p>' });
        },
      },
      // Stands in for the provenance bootstrap: it runs in every new document's own window.
      initScript: () => {
        window.inventedBootstrap = location.pathname;
      },
    },
  );
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.id = 'late';
    frame.src = '/frame';
    window.frameLoaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
    document.body.append(frame);
  });
  await arrived;
  // X-ray's mutation observer has run for the inserted frame (it runs before any later task).
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)));
  release();
  await page.evaluate(() => window.frameLoaded);
  const observed = await page.evaluate(() => {
    const frame = document.getElementById('late');
    const api = document.getElementById('paqvilo-xray').__px;
    const inner = frame.contentDocument.getElementById('inner');
    api.select(inner);
    return { bootstrap: frame.contentWindow.inventedBootstrap, selected: api.selectedNode() === inner };
  });
  assert.deepEqual(observed, { bootstrap: '/frame', selected: true });
});
