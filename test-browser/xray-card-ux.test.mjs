// @test-kind contract: Paqvilo's own Lense X-ray card (hover over own UI and the dev panel pill under the shield, compact enclosing-component actions, page-CSS isolation) on an invented loopback portal
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { listenOwnedServer, ownCloseSteps } from './helpers/owned-server.mjs';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { OverlaySession } from '../lense/session.mjs';
import { attachSession } from '../lense/browser.mjs';
import { enablePanel } from '../lense/panel.mjs';
import { SITE } from '../test/fixture.mjs';
import { inspectionFixture } from '../test/source-inspection-fixture.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';
import { modelDrivenPanelInspection } from '../lense/model-driven-panel.mjs';

// X-ray paints in animation frames; after two more frames every paint scheduled before the call has run.
const painted = (page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

// A hostile portal stylesheet: inherited text styles on body, an !important colour on every element and right-to-left
// on every div (the X-ray host is a div; `all` does not reset direction).
const hostileCss =
  'body{color:red;font:30px serif;letter-spacing:5px}*{color:red!important}div{direction:rtl!important;unicode-bidi:bidi-override!important}';
const html = `<!doctype html><html><head><style>${hostileCss}</style></head><body><main style="padding:40px 40px 40px 520px"><form data-entityname="fx_widget" data-formid="widget-edit"><label for="fx_title">Title</label><input id="fx_title" name="fx_title"></form></main></body></html>`;

test('the X-ray card ignores page hover over its own UI, keeps page CSS out and opens every enclosing definition', async (t) => {
  const fx = inspectionFixture();
  ownedFixture(t).remove(async () => fx.cleanup());
  const server = http.createServer((req, res) =>
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html),
  );
  let context, panel, detach;
  ownCloseSteps(t, [() => panel?.dispose(), () => detach?.(), () => context?.close()]);
  const origin = await listenOwnedServer(t, server);
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.fallback() : route.abort(),
  );
  const session = new OverlaySession({
    sourceDir: fx.portal,
    origin,
    site: structuredClone(SITE),
    sourceMaps: false,
    siteName: 'Card fixture',
    envName: 'loopback',
    stateDir: fx.work,
    browser: {},
    mirageConfig: { project: fx.project },
  });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  detach = await attachSession(context, session);
  const opened = [];
  let arrived = () => {};
  panel = enablePanel(context, session, {
    open: async (...args) => {
      opened.push(args);
      arrived();
      return null;
    },
  });
  await page.goto(origin);
  const xray = page.locator('#paqvilo-xray');
  await page.locator('#paqvilo-panel .pill').click();
  await page.locator('#paqvilo-panel').getByRole('button', { name: 'Toggle Lense X-ray' }).click();
  await xray.getByRole('toolbar').waitFor();
  const field = await page.locator('#fx_title').boundingBox();
  await page.mouse.click(field.x + field.width / 2, field.y + field.height / 2);
  await page.waitForFunction(
    () => document.getElementById('paqvilo-xray').__px.selection()?.evidence?.owner.status === 'exact',
  );
  const enclosing = xray.locator('[data-evidence-role=enclosing] .ie-row');
  await enclosing
    .filter({ has: page.locator('[data-action=open]') })
    .first()
    .waitFor();

  // Every enclosing component that has a local definition offers open and copy; each open reaches the editor.
  const rows = await enclosing.evaluateAll((items) =>
    items.map((item) => ({
      kind: item.dataset.hierarchyKind,
      open: item.querySelector('[data-action=open]')?.disabled === false,
      copy: Boolean(item.querySelector('[data-action=copy]')),
    })),
  );
  for (const kind of ['table', 'basic-form', 'webpage'])
    assert.deepEqual(
      rows.find((row) => row.kind === kind),
      { kind, open: true, copy: true },
      JSON.stringify(rows),
    );
  // A web page row opens its record (.webpage.yml), not its copy (.webpage.copy.html, listed under Page files).
  const expectedFile = {
    table: /Entity\.xml$/,
    'basic-form': /Widget\.basicform\.yml$/,
    webpage: /Home\.webpage\.yml$/,
  };
  for (const [kind, file] of Object.entries(expectedFile)) {
    const next = new Promise((resolve) => (arrived = resolve));
    await xray
      .locator(`[data-evidence-role=enclosing] .ie-row[data-hierarchy-kind="${kind}"]`)
      .getByRole('button', { name: /^Open .+ in the editor$/ })
      .click();
    await next;
    assert.match(opened.at(-1)?.[1] ?? '', file, kind);
  }

  // Pointer over the card: no page outline and no tooltip; back on the page they return.
  const tipHidden = () => xray.evaluate((host) => host.shadowRoot.querySelector('.tip').hidden);
  const hoverShown = () => xray.evaluate((host) => host.shadowRoot.querySelector('.mark.hover')?.isConnected === true);
  const label = await page.locator('label[for=fx_title]').boundingBox();
  await page.mouse.move(label.x + 5, label.y + label.height / 2);
  await painted(page);
  assert.equal(await tipHidden(), false, 'a hovered page element shows its tooltip');
  assert.equal(await hoverShown(), true, 'a hovered page element is outlined');
  const card = await xray.locator('.card').boundingBox();
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2, { steps: 4 });
  await painted(page);
  assert.equal(await tipHidden(), true, 'no page tooltip over the card');
  assert.equal(await hoverShown(), false, 'no page outline over the card');
  await page.mouse.move(label.x + 5, label.y + label.height / 2, { steps: 4 });
  await painted(page);
  assert.equal(await tipHidden(), false, 'the tooltip resumes on the page');

  // Page text styles do not reach the card, including through the panel's portal theme.
  const styles = await xray.evaluate((host) =>
    ['.title', '.cardhead .ie-state', '.inspection-evidence .sub:not(.path)', '.bar button'].map((selector) => {
      const style = getComputedStyle(host.shadowRoot.querySelector(selector));
      return {
        selector,
        color: style.color,
        font: style.fontFamily,
        letterSpacing: style.letterSpacing,
        direction: style.direction,
      };
    }),
  );
  for (const style of styles) {
    assert.notEqual(style.color, 'rgb(255, 0, 0)', JSON.stringify(style));
    assert.match(style.font, /^"Segoe UI"/, JSON.stringify(style));
    assert.equal(style.letterSpacing, 'normal', JSON.stringify(style));
    assert.equal(style.direction, 'ltr', JSON.stringify(style));
  }
  // The dev panel's pill lies under X-ray's pointer shield. Over it the page is not hovered, and a click reaches it.
  const pill = await page.locator('#paqvilo-panel .pill').boundingBox();
  await page.mouse.move(pill.x + pill.width / 2, pill.y + pill.height / 2, { steps: 4 });
  await painted(page);
  assert.equal(await tipHidden(), true, 'no page tooltip over the pill');
  assert.equal(await hoverShown(), false, 'no page outline over the pill');
  await page.mouse.click(pill.x + pill.width / 2, pill.y + pill.height / 2);
  await page.locator('#paqvilo-panel .wrap.open').waitFor();
  assert.deepEqual(errors, []);
});

// A model-driven record form in local simulation: the report the model-driven panel builds from an invented catalogue,
// and a provider shaped like Mirage's registry (the owner, then each enclosing table, form and section, repeated per
// enclosing region and named by its ID).
const formId = 'fa110000-0000-4000-8000-0000000000aa';
const formSource = 'solution/Entities/inv_project/FormXml/main/{fa110000-0000-4000-8000-0000000000aa}.xml';
const tableSource = 'solution/Entities/inv_project/Entity.xml';
const modelDrivenPage = `<!doctype html><html><body><main style="padding:40px 40px 40px 520px"><form id="record-form"><label for="field-inv_budget">Budget</label><input id="field-inv_budget" name="inv_budget"></form></main></body></html>`;

test('a model-driven field in local simulation names its form exactly, opens it and lists each context once', async (t) => {
  const server = http.createServer((req, res) =>
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(modelDrivenPage),
  );
  let context;
  ownCloseSteps(t, [() => context?.close()]);
  const origin = await listenOwnedServer(t, server);
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.fallback() : route.abort(),
  );
  const report = modelDrivenPanelInspection({
    localSimulation: true,
    sourceRevision: '1',
    sourceDir: 'C:/invented',
    resources: [],
    context: { pageType: 'entityrecord', entity: 'inv_project', formId },
    catalogue: {
      forms: [
        {
          id: formId,
          entity: 'inv_project',
          name: 'Project',
          type: 'main',
          source: formSource,
          events: [],
          controls: [{ kind: 'field', name: 'inv_budget', id: 'inv_budget' }],
        },
      ],
      tables: [
        {
          logicalName: 'inv_project',
          label: 'Project',
          source: tableSource,
          columns: [{ name: 'inv_budget', label: 'Budget', type: 'money', source: tableSource }],
        },
      ],
      views: [],
      commands: [],
    },
    sourceRefs: [
      {
        id: 'model-source:form',
        key: 'model-source:form',
        sourceKey: 'model-source:form',
        componentKey: 'form:' + formId,
        kind: 'form',
        name: 'Project',
        recordId: formId,
        ref: formSource,
        sourceRevision: '1',
        contentRevision: 'content-1',
        relationship: 'definition',
      },
    ],
  });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  const sourceDir = String.raw`C:\invented\sources`;
  // The selected field's own file, under the source folder: the placement of its control in the form.
  const ownerRef = {
    id: 'model-source:control',
    key: 'model-source:control',
    sourceKey: 'model-source:control',
    componentKey: `control:${formId}:inv_budget:body`,
    kind: 'control',
    name: 'inv_budget',
    ref: [sourceDir, ...formSource.split('/')].join('\\'),
    sourceRevision: '1',
    contentRevision: 'content-1',
    relationship: 'placement',
    fieldPath: ['controls', 'inv_budget'],
    region: { start: 10, end: 40, line: 2, column: 1 },
  };
  const data = { origin, token: 'invented-model-driven', sourceRevision: '1', modelDriven: true, sourceDir };
  await page.evaluate(xrayUi, data);
  await page.evaluate(
    ({ data, report, formId, ownerRef }) => {
      const component = (kind, key, name, extra = {}) => ({ kind, key, name, ...extra });
      const fact = (dimension, binding, scope) => ({
        subject: binding.key,
        predicate: 'contains',
        dimension,
        kind: 'observed',
        proof: 'mirage-registry',
        binding,
        scope,
      });
      const section = `${formId}:{d3002aa1-0bbb-4415-8bc2-29e49766c0af}`;
      window.__paqviloModelPanelApi = async ({ name, body }) =>
        name === 'provenance'
          ? { ok: true, version: 1, scope: body.scope, anchorGeneration: body.anchorGeneration, sourceRefs: [ownerRef] }
          : { ok: false };
      window.__paqviloModelDrivenProvider = {
        query: (node, { scope, anchorGeneration }) => ({
          version: 1,
          mode: 'local',
          scope,
          anchorGeneration,
          facts: [
            {
              ...fact(
                'owner',
                component('control', `control:${formId}:inv_budget:body`, 'inv_budget', { formId }),
                scope,
              ),
              predicate: 'identity',
              sourceRefIds: [ownerRef.id],
            },
          ],
          contextFacts: [
            fact('context', component('table', 'table:inv_project', 'inv_project'), scope),
            fact('context', component('form', 'form:' + formId, formId), scope),
            fact('enclosing', component('section', 'section:' + section, section, { formId }), scope),
            fact('context', component('table', 'table:inv_project', 'inv_project'), scope),
            fact('enclosing', component('form', 'form:' + formId, formId, { entity: 'inv_project' }), scope),
          ],
          sourceKeys: [ownerRef.componentKey],
          sourceRefs: [ownerRef],
          availability: [],
        }),
      };
      const api = document.getElementById('paqvilo-xray').__px;
      api.update(data, report);
      api.toggle(true);
    },
    { data, report, formId, ownerRef },
  );
  const xray = page.locator('#paqvilo-xray');
  await xray.getByRole('toolbar').waitFor();
  // The welcome speaks of the app, not of a portal and its templates.
  const welcome = await xray.locator('.welcome').innerText();
  assert.match(welcome, /Select an element of the app/);
  assert.doesNotMatch(welcome, /portal|templates/i);

  const field = await page.locator('#field-inv_budget').boundingBox();
  await page.mouse.click(field.x + field.width / 2, field.y + field.height / 2);
  await page.waitForFunction(
    () => document.getElementById('paqvilo-xray').__px.selection()?.evidence?.owner.status === 'exact',
  );
  // The field's own file shows its path in the source folder, as Page files does; the full path is the tooltip. Its
  // internal field path (controls.inv_budget) is not shown: the header already names the field.
  const ownerPath = xray.locator('[data-evidence-role=owner] .sub.path');
  await ownerPath.waitFor();
  // Its ID segment reads {…}, as every visible Solution path does; the tooltip keeps the full path.
  assert.equal(await ownerPath.innerText(), 'solution/Entities/inv_project/FormXml/main/{…}.xml');
  assert.equal(await ownerPath.getAttribute('title'), ownerRef.ref);
  assert.doesNotMatch(await xray.locator('[data-evidence-role=owner]').innerText(), /Field:|controls\./);
  // The header names the field by its display name and logical name.
  assert.equal(await xray.locator('.cardhead .title').innerText(), 'Budget · inv_budget');
  // The open form is the form of this page: exact, with open and copy, not a "Likely" form of the configuration.
  const form = xray.locator(`[data-evidence-role=enclosing] .ie-row[data-hierarchy-key="form:${formId}"]`);
  assert.equal(await form.locator('.ie-state').getAttribute('data-status'), 'exact');
  assert.equal(await form.locator('[data-relation]').innerText(), 'Contains it');
  const open = form.getByRole('button', { name: 'Open form Project in the editor' });
  assert.equal(await open.isEnabled(), true);
  assert.equal(await form.getByRole('button', { name: 'Copy the source reference of form Project' }).count(), 1);
  const opened = page.evaluate(
    () =>
      new Promise((resolve) =>
        document
          .getElementById('paqvilo-xray')
          .addEventListener('paqvilo-xray', (event) => event.detail.action === 'open' && resolve(event.detail.ref)),
      ),
  );
  await open.click();
  assert.equal(await opened, formSource);
  // Context: the table once; the form (already in Contained in) and the unnamed section not at all. No GUID is shown,
  // and Mirage's match claims no file it did not report.
  await xray.locator('[data-disclosure="evidence-context"] summary').click();
  assert.deepEqual(
    await xray.locator('[data-evidence-role=context] .ie-row .name > span:first-child').allInnerTexts(),
    ['inv_project'],
  );
  // Paths included: a form file named by its ID shows {…}.
  await xray.locator('[data-disclosure="page-context"] summary').click();
  const text = await xray.locator('.card').innerText();
  assert.match(text, /FormXml\/main\/\{…\}\.xml/);
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
  assert.doesNotMatch(text, /Not in your sources|None found/);
  assert.doesNotMatch(
    await xray.locator('.cardhead .ie-state').getAttribute('title'),
    /from this file/,
    'the owner badge names no file the source section does not list',
  );
  // The legend and the layer select name the app's other content in its own words, not a portal's templates.
  assert.match(await xray.locator('.legend').innerText(), /Page content/);
  assert.doesNotMatch(await xray.locator('.legend').innerText(), /Templates/);
  // In a 500px window the card keeps a usable width, and a row's chips take their own line instead of cutting the
  // name.
  await page.setViewportSize({ width: 500, height: 900 });
  await page.evaluate(() => document.getElementById('paqvilo-xray').__px.refreshSelection('narrow-window'));
  await painted(page);
  assert.ok((await xray.locator('.card').boundingBox()).width >= 340);
  const formName = form.locator('.name > span:first-child');
  assert.equal(await formName.evaluate((node) => node.scrollWidth <= node.clientWidth), true, 'the name is not cut');
  assert.equal(await formName.innerText(), 'Project');
  assert.deepEqual(errors, []);
});
