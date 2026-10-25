import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { startModelDrivenInspector } from '../lense/model-driven-inspector.mjs';
import { createModelDrivenOverlay } from '../lense/model-driven.mjs';
import { createHash } from 'node:crypto';

const formId = '11111111-1111-4111-8111-111111111111';
// A strict client API: like the loopback app's bounded Xrm, an unsupported member throws.
const strictXrm = `(() => {
  const strict = (value, name) => new Proxy(value, { get(target, key) {
    if (typeof key === 'symbol' || key === 'then') return Reflect.get(target, key);
    if (!Object.hasOwn(target, key)) throw new Error('Invented client API does not support ' + name + '.' + String(key));
    return target[key];
  } });
  const attribute = strict({ getName: () => 'inv_title', getIsDirty: () => false, getAttributeType: () => 'string' }, 'attribute');
  const entity = strict({ getEntityName: () => 'inv_item', getId: () => '', attributes: strict({ get: () => [attribute], forEach: callback => [attribute].forEach(callback) }, 'attributes') }, 'entity');
  const ui = strict({ getFormType: () => 1, formSelector: strict({ getCurrentItem: () => strict({ getId: () => '{${formId}}' }, 'item') }, 'formSelector') }, 'ui');
  const form = strict({ data: strict({ entity }, 'data'), ui, getAttribute: () => [attribute] }, 'form');
  const context = strict({ getClientUrl: () => location.origin, userSettings: strict({ userId: '{22222222-2222-4222-8222-222222222222}', roles: strict({ getLength: () => 1 }, 'roles') }, 'userSettings') }, 'globalContext');
  window.Xrm = strict({ Page: form, Utility: strict({ getGlobalContext: () => context }, 'Utility'), Navigation: strict({ openForm: async () => ({}), openUrl: () => {} }, 'Navigation') }, 'Xrm');
})();`;
const page = `<!doctype html><title>Invented strict app</title><h1>Invented record</h1>
  <form><div class="field"><label for="field-inv_title">Title</label><input id="field-inv_title" name="inv_title"></div></form>
  <script src="/xrm.js"></script><script src="/WebResources/inv_form.js"></script>`;
const formXml =
  '<form><tabs><tab name="general"><columns><column><sections><section name="details"><rows><row><cell><labels><label description="Title" languagecode="1033"/></labels><control datafieldname="inv_title"/></cell></row></rows></section></sections></column></columns></tab></tabs></form>';

test(
  'a strict CSP and throwing client API keep Actions readable and runnable, X-ray outlined and bound, and overrides applied',
  { timeout: 30000 },
  async (t) => {
    const owner = ownedFixture(t),
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-strict-host-'));
    owner.remove(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const server = http.createServer((request, response) => {
      const csp = {
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'",
      };
      if (request.url === '/xrm.js')
        return response.writeHead(200, { 'content-type': 'text/javascript', ...csp }).end(strictXrm);
      if (request.url.startsWith('/WebResources/'))
        return response
          .writeHead(200, { 'content-type': 'text/javascript', ...csp })
          .end('window.formSource = "native";');
      response.writeHead(200, { 'content-type': 'text/html', ...csp }).end(page);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    owner.add(() => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
    owner.add(() => browser.close());
    const context = await browser.newContext(),
      tab = await context.newPage();
    tab.setDefaultTimeout(5000);
    const problems = [];
    tab.on('pageerror', (error) => problems.push(error.message));
    tab.on('console', (message) => {
      if (['error', 'warning'].includes(message.type())) problems.push(message.text());
    });
    const imported = {
      assets: new Map([
        [
          'inv_form.js',
          {
            name: 'inv_form.js',
            file: path.join(root, 'inv_form.js'),
            mime: 'text/javascript',
            data: Buffer.from('window.formSource = "local";'),
          },
        ],
      ]),
      resources: [{ name: 'inv_form.js' }],
      diagnostics: [],
      layers: [
        {
          dir: root,
          documents: [
            {
              file: path.join(root, 'main.xml'),
              facts: {
                appComponents: { forms: [{ id: formId, entity: 'inv_item', name: 'Invented main', xml: formXml }] },
              },
            },
          ],
        },
      ],
    };
    await fs.writeFile(path.join(root, 'main.xml'), formXml);
    const formSource = await fs.realpath(path.join(root, 'main.xml'));
    imported.layers[0].documents[0].file = formSource;
    imported.metadata = { sourceRevisions: { [formSource]: createHash('sha256').update(formXml).digest('hex') } };
    const overlay = createModelDrivenOverlay({
      origin,
      imported,
      ownsRequest: (request) => request.frame().page() === tab,
    });
    const { interceptOrigin } = await import('../lense/intercept.mjs');
    owner.add(
      await interceptOrigin(context, origin, (route) => overlay.handle(route), {
        ownsPage: (candidate) => candidate === tab,
      }),
    );
    const inspector = await startModelDrivenInspector({
      context,
      page: tab,
      overlay,
      imported,
      cfg: { origin, stateDir: path.join(root, '.state'), sourceDir: root, siteName: 'invented', envName: 'loopback' },
    });
    owner.add(() => inspector.close());
    await tab.goto(origin + '/main.aspx?etn=inv_item');
    assert.equal(await tab.evaluate(() => window.formSource), 'local');
    const host = tab.locator('#paqvilo-panel');
    await host.waitFor();
    await tab.waitForFunction(() => document.getElementById('paqvilo-panel').__paqModelActions);
    await tab.keyboard.press('Alt+Shift+P');
    await host
      .getByRole('tab', { name: /^Overrides/ })
      .filter({ hasText: '1' })
      .waitFor();

    // Every documented action is listed; available ones describe themselves and their labels are legible.
    await host.getByRole('tab', { name: 'Actions', exact: true }).click();
    const { MODEL_DRIVEN_ACTIONS } = await import('../lense/model-driven-actions.mjs');
    await host.getByRole('button', { name: /^Changed fields Show dirty fields/ }).waitFor();
    assert.equal(await host.locator('.actions-select').count(), MODEL_DRIVEN_ACTIONS.length);
    const legible = await host.evaluate((element) =>
      [...element.shadowRoot.querySelectorAll('.actions-select')].every(
        (button) =>
          getComputedStyle(button).color !== getComputedStyle(button.closest('.actions-panel')).backgroundColor,
      ),
    );
    assert.equal(legible, true, 'action labels must not render in the panel background color');
    await host.getByRole('button', { name: /^Changed fields/ }).click();
    await host.getByRole('button', { name: 'Run action', exact: true }).click();
    await host.locator('.actions-status').filter({ hasText: 'Completed.' }).waitFor();
    await host.getByText('The current form draft has no changed attributes.').waitFor();
    assert.match(
      await host.getByRole('button', { name: /^Table processes/ }).textContent(),
      /does not report its Web API version/,
    );

    // Optional native collection getters throw. Source inspection stays usable,
    // and a name-based field join remains a candidate rather than runtime proof.
    await host.getByRole('tab', { name: 'Inspect', exact: true }).click();
    await host.getByText('invented · loopback · 1 Solution roots').waitFor();
    assert.equal(await host.getByText('no exported page matches this address').count(), 0);
    await host.getByRole('button', { name: 'Toggle Lense X-ray', exact: true }).click();
    const xray = tab.locator('#paqvilo-xray');
    await tab.waitForFunction(() =>
      [...document.getElementById('paqvilo-xray').shadowRoot.querySelectorAll('.marks .mark')].some(
        (mark) => mark.style.width && mark.getBoundingClientRect().width > 0,
      ),
    );
    const field = await tab.locator('input[name=inv_title]').boundingBox();
    await tab.mouse.click(field.x + field.width / 2, field.y + field.height / 2);
    await xray
      .locator('[data-inspection-evidence][data-owner-status="candidate"][data-source-status="candidate"]')
      .waitFor();
    const evidence = await tab.evaluate(
      () => document.getElementById('paqvilo-xray').__px.selectionState().identity.evidence,
    );
    assert.ok(evidence.candidates.some((item) => item.component.controlName === 'inv_title'));
    assert.ok(
      evidence.source.refs.some((ref) => ref.ref === formSource && ref.region?.line),
      'current real FormXml remains a candidate definition under a strict host',
    );
    assert.equal(inspector.snapshot().inspectionError, '');
    for (const collection of ['controls', 'tabs', 'quickForms'])
      assert.equal(inspector.snapshot().nativeStructure[collection].availability, 'throws');
    assert.equal(await xray.getByText('Ambiguous field identifier').count(), 0);
    await tab.keyboard.press('Escape');
    const heading = await tab.getByRole('heading', { name: 'Invented record' }).boundingBox();
    await tab.mouse.click(heading.x + 5, heading.y + heading.height / 2);
    // An empty identifier must not match every exported control without an id.
    await xray.locator('[data-inspection-evidence][data-owner-status="unavailable"]').waitFor();
    const headingEvidence = await tab.evaluate(
      () => document.getElementById('paqvilo-xray').__px.selectionState().identity.evidence,
    );
    assert.ok(
      !headingEvidence.candidates.some((item) => item.component.controlName === 'inv_title'),
      'an empty heading identifier cannot borrow a field',
    );
    assert.ok(
      headingEvidence.facts.some((item) => item.component?.key === 'form:' + formId),
      'the current native form remains context for the heading',
    );
    assert.equal(await xray.locator('.element-label').textContent(), 'h1');
    assert.deepEqual(problems, []);
  },
);
