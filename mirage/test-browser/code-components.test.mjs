// @test-kind unproven: local PCF host behaviour on loopback pages and portal sources (resources, lifecycle, state, Web API, datasets); the field host tests carry their own capture tags
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import http from 'node:http';
import { ownedFixture, drainFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

/** Opens the simulator's page in a fresh context once its code components are ready, recording errors and non-local requests. */
async function openPortal(t, app) {
  ownedFixture(t).add(() => app.close());
  const context = await browser.newContext();
  ownedFixture(t).add(() => context.close());
  const page = await context.newPage(),
    errors = [],
    external = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith(app.url)) external.push(request.url());
  });
  await page.goto(app.url);
  await page.locator('[data-pcf-ready=true]').waitFor();
  return { page, errors, external };
}

test('standard PCF host loads only declared local resources and preserves lifecycle, bound output and disabled context', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-pcf-browser-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const id = 'd0000000-0000-4000-8000-000000000001';
  const portal = path.join(root, 'portal'),
    solution = path.join(root, 'solution');
  const files = {
    'portal/website.yml': 'adx_websiteid: site\nadx_name: Synthetic PCF',
    'portal/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml':
      'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html': `<html><body>{% codecomponent name:${id} value:'Initial' disabled:true %}<script>document.addEventListener('paqvilo:pcf-output',e=>window.output=e.detail);</script></body></html>`,
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>Synthetic</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Controls/tst_Synthetic.Editor/ControlManifest.xml':
      '<manifest><control namespace="Synthetic" constructor="Editor" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="bound"/><resources><code path="bundle.js"/><css path="style.css"/></resources></control></manifest>',
    'solution/Controls/tst_Synthetic.Editor/ControlManifest.xml.data.xml':
      '<CustomControl><Name>tst_Synthetic.Editor</Name></CustomControl>',
    'solution/Controls/tst_Synthetic.Editor/style.css': '.synthetic-editor{--pcf-source:declared;}',
    'solution/Controls/tst_Synthetic.Editor/bundle.js': `window.ComponentFramework.registerControl('Synthetic.Editor',class{init(context,notify,state,container){window.lifecycle=['init'];this.input=document.createElement('input');this.input.className='synthetic-editor';this.input.value=context.parameters.value.raw;this.input.disabled=context.mode.isControlDisabled;this.input.addEventListener('input',notify);container.appendChild(this.input);}updateView(context){window.lifecycle.push('update');window.disabled=context.mode.isControlDisabled;}getOutputs(){return{value:this.input.value};}destroy(){window.lifecycle.push('destroy');}});`,
  };
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  const app = await createSimulator({
    sourceDir: portal,
    solutionRoots: [solution],
    port: 0,
    watch: false,
    observed: {
      codeComponents: { [id]: 'tst_Synthetic.Editor' },
      evidence: 'Invented fixture manifest and literal tag',
    },
  });
  const { page, errors, external } = await openPortal(t, app);
  assert.equal(await page.locator('input').inputValue(), 'Initial');
  // A Liquid tag host is never disabled and ignores an argument that names no manifest property (IsDisabled false;
  // paqvilo-developer pcf-parity summary-D, r1).
  assert.equal(await page.locator('input').isDisabled(), false);
  assert.equal(
    await page.locator('input').evaluate((node) => getComputedStyle(node).getPropertyValue('--pcf-source')),
    'declared',
  );
  await page.locator('input').evaluate((node) => {
    node.value = 'Output';
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // The Liquid tag host takes the output about 100 ms after the notify and runs no updateView for it
  // (paqvilo-developer pcf-parity summary-F section 2; the timing is asserted in pcf-notify-debounce.test.mjs).
  await page.waitForFunction(() => window.output !== undefined);
  assert.deepEqual(await page.evaluate(() => window.output), { value: 'Output' });
  assert.deepEqual(await page.evaluate(() => window.lifecycle), ['init', 'update']);
  // The page loads the bundle from its native address; the host spec still names the catalogue path.
  assert.equal(await page.locator('script[src^="/_pcfwebresource/"]').count(), 1);
  const catalogPath = /\/__sim-static\/pcf\/[0-9a-f]+\/bundle\.js/.exec(await page.content())[0];
  assert.equal((await fetch(app.url + catalogPath.replace('bundle.js', 'secret.js'))).status, 404);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});

async function hostFixture(t) {
  const host = await fs.readFile(new URL('../lib/code-components-client.js', import.meta.url), 'utf8');
  const requests = [];
  const server = http.createServer((request, response) => {
    if (request.url === '/host.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(host);
      return;
    }
    if (request.url === '/image.bin') {
      response.end(Buffer.alloc(512 * 1024, 97));
      return;
    }
    if (request.url.startsWith('/_api/')) {
      requests.push({ url: request.url, method: request.method, headers: request.headers });
      response.setHeader('Content-Type', 'application/json');
      // As the portal Web API answers a pcf-entity-logical-name request naming no known table (summary-F section 1).
      if (!/^\/_api\/tst_row(?=[(?]|$)/.test(request.url)) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: { code: '9004010A', message: 'An unexpected error occurred' } }));
      } else if (request.method === 'POST') {
        response.statusCode = 204;
        response.setHeader('OData-EntityId', '/_api/tst_rows(d0000000-0000-4000-8000-000000000002)');
        response.end();
      } else if (request.url.includes('denied')) {
        response.statusCode = 403;
        response.end(JSON.stringify({ error: { code: 'AccessDenied', message: 'Fixture permission denied' } }));
      } else
        response.end(
          JSON.stringify({ value: [{ tst_rowid: 'd0000000-0000-4000-8000-000000000002', tst_title: 'Visible row' }] }),
        );
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end('<html><body><script src="/host.js"></script></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let context;
  ownedFixture(t).add(() =>
    drainFixture([
      () => context?.close(),
      () =>
        new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        }),
    ]),
  );
  // Date outputs render in the browser's local zone; pin it so a host west of UTC sees the same calendar date.
  context = await browser.newContext({ timezoneId: 'UTC' });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  return { page, requests };
}

test('PCF classic SDK bundle resolves its declared export after repeated whitespace and block comments', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-pcf-classic-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const portal = path.join(root, 'portal'),
    solution = path.join(root, 'solution');
  const files = {
    'portal/website.yml': 'adx_websiteid: site\nadx_name: Invented classic bundle',
    'portal/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml':
      'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html':
      '<html><body>{% codecomponent name:tst_Synthetic.Editor value:"Classic value" %}</body></html>',
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>Synthetic</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Controls/tst_Synthetic.Editor/ControlManifest.xml':
      '<manifest><control namespace="Synthetic" constructor="Editor" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="bound"/><resources><code path="bundle.js"/></resources></control></manifest>',
    'solution/Controls/tst_Synthetic.Editor/ControlManifest.xml.data.xml':
      '<CustomControl><Name>tst_Synthetic.Editor</Name></CustomControl>',
    'solution/Controls/tst_Synthetic.Editor/bundle.js':
      '\uFEFF \n/* generated */\t/** license */\nvar $ClassicBundle_2 ;\n$ClassicBundle_2={Editor:class{init(context,notify,state,container){window.classicInit=(window.classicInit||0)+1;this.input=document.createElement("input");this.input.value=context.parameters.value.raw;container.appendChild(this.input);}updateView(){}getOutputs(){return{value:this.input.value};}destroy(){}}};',
  };
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }
  const app = await createSimulator({ sourceDir: portal, solutionRoots: [solution], port: 0, watch: false });
  const { page, errors, external } = await openPortal(t, app);
  assert.equal(await page.locator('input').inputValue(), 'Classic value');
  assert.equal(await page.evaluate(() => window.classicInit), 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});

// @test-kind unproven+observation: local model of repeated loopback controls; getResource failing at once and the -1 allocated size follow the live capture of 2026-11-26 (paqvilo-developer pcf-parity summary-A, capture r1 actions-save)
test('PCF repeated controls have separate instances and state, typed parameters, refused resources and removal cleanup', async (t) => {
  const { page } = await hostFixture(t);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate(async () => {
    window.contexts = [];
    window.states = [];
    window.destroyed = [];
    window.notifications = [];
    window.propertyUpdates = [];
    document.addEventListener('paqvilo:pcf-output', (event) => window.notifications.push(event.detail));
    window.ComponentFramework.registerControl(
      'Synthetic.Types',
      class {
        init(context, notify, state, container) {
          this.container = container;
          this.context = context;
          this.notify = notify;
          window.contexts.push(context);
          window.states.push(state);
          context.mode.trackContainerResize(true);
          context.mode.setControlState({ owner: container.id });
          container.style.width = '200px';
          container.style.height = '40px';
          container.addEventListener('output', notify);
        }
        updateView(context) {
          window.propertyUpdates.push({ id: this.container.id, properties: [...context.updatedProperties] });
          this.container.dataset.updates = String(Number(this.container.dataset.updates || '0') + 1);
          this.container.dataset.updatedProperties = context.updatedProperties.join(',');
        }
        getOutputs() {
          return { choice: 4, inputOnly: 'must not propagate' };
        }
        destroy() {
          window.destroyed.push(this.container.id);
        }
      },
    );
    const spec = {
      id: 'same',
      constructor: 'Synthetic.Types',
      resources: [{ kind: 'img', url: '/image.bin' }],
      properties: [
        { name: 'choice', 'of-type': 'OptionSet', usage: 'bound' },
        { name: 'flags', 'of-type': 'MultiSelectOptionSet', usage: 'bound' },
        { name: 'reference', 'of-type': 'Lookup.Simple', usage: 'bound' },
        { name: 'enabled', 'of-type': 'TwoOptions', usage: 'input', 'default-value': '1' },
        { name: 'count', types: ['Whole.None'], usage: 'input', 'default-value': '7' },
        { name: 'grouped', types: ['Whole.None', 'FP', 'Decimal'], usage: 'input', 'default-value': '7.25' },
        { name: 'inputOnly', 'of-type': 'SingleLine.Text', usage: 'input' },
      ],
      strings: {},
      args: {
        choice: '3',
        flags: '1,2',
        reference: { id: 'd0000000-0000-4000-8000-000000000002', entityType: 'tst_row', name: 'Selected' },
      },
      identity: { roles: [] },
      mappings: {},
    };
    for (let index = 0; index < 2; index++) {
      const target = document.createElement('div');
      document.body.append(target);
      await window.__paqviloPcf.mount(spec, target);
    }
  });
  assert.equal(await page.locator('[data-pcf-ready]').count(), 2);
  assert.deepEqual(
    await page.evaluate(() => Array.from(document.querySelectorAll('[data-pcf-ready]'), (node) => node.id)),
    ['same-1', 'same-2'],
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      choice: window.contexts[0].parameters.choice.raw,
      flags: window.contexts[0].parameters.flags.raw,
      reference: window.contexts[0].parameters.reference.raw,
      enabled: window.contexts[0].parameters.enabled.raw,
      count: window.contexts[0].parameters.count.raw,
      grouped: window.contexts[0].parameters.grouped.raw,
      groupedType: window.contexts[0].parameters.grouped.type,
    })),
    {
      choice: 3,
      flags: [1, 2],
      reference: [{ id: 'd0000000-0000-4000-8000-000000000002', entityType: 'tst_row', name: 'Selected' }],
      enabled: true,
      count: 7,
      grouped: 7.25,
      groupedType: 'Decimal',
    },
  );
  assert.deepEqual(await page.evaluate(() => window.states), [{}, {}]);
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('paqvilo-pcf:same-1')).owner), 'same-1');
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('paqvilo-pcf:same-2')).owner), 'same-2');
  await page.locator('#same-1').evaluate((node) => node.dispatchEvent(new Event('output')));
  // A resize can legitimately follow the output callback before the browser is polled.
  await page.waitForFunction(() =>
    window.propertyUpdates.some((update) => update.id === 'same-1' && update.properties.join(',') === 'choice'),
  );
  assert.deepEqual(await page.evaluate(() => window.notifications), [{ choice: 4 }]);
  // Power Pages calls getResource's failure callback at once with no argument and reports no allocated size, also
  // after trackContainerResize(true) and a resize (summary-A, capture r1 actions-save).
  assert.deepEqual(
    await page.evaluate(() => {
      const calls = [];
      window.contexts[0].resources.getResource(
        'image.bin',
        () => calls.push('success'),
        (...args) => calls.push('failure/' + args.length),
      );
      return calls;
    }),
    ['failure/0'],
  );
  await page.locator('#same-1').evaluate((node) => {
    node.style.width = '250px';
  });
  assert.deepEqual(
    await page.evaluate(() => [window.contexts[0].mode.allocatedWidth, window.contexts[0].mode.allocatedHeight]),
    [-1, -1],
  );
  await page.locator('#same-1').evaluate((node) => node.remove());
  await page.waitForFunction(() => window.destroyed.length === 1);
  assert.deepEqual(await page.evaluate(() => window.destroyed), ['same-1']);
  assert.equal(await page.locator('[data-pcf-ready]').count(), 1);
  assert.deepEqual(errors, []);
});

// @test-kind observation+contract: the request form (/_api/<logical name> with pcf-entity-logical-name, the anti-forgery token, no Prefer for a maxPageSize, which is not validated, nextLink undefined) and the rejection with undefined follow live captures (paqvilo-developer pcf-parity capture r1 actions-save and summary-F section 1, runs fa and fb); the local refusals of foreign URLs, record ids and fragments without a request and the reasons in inspect().webApiErrors are Paqvilo's own diagnostics
test('PCF Web API names the logical name, sends the token, ignores maxPageSize and keeps native create IDs while rejecting navigation in queries and record IDs', async (t) => {
  const { page, requests } = await hostFixture(t);
  await page.evaluate(async () => {
    window.shell = {
      getTokenDeferred: () => ({
        done(callback) {
          callback('fixture-token');
          return this;
        },
        fail() {
          return this;
        },
      }),
    };
    window.ComponentFramework.registerControl(
      'Synthetic.Api',
      class {
        init(context) {
          window.context = context;
        }
        updateView() {}
      },
    );
    const target = document.createElement('div');
    document.body.append(target);
    await window.__paqviloPcf.mount(
      {
        id: 'api',
        constructor: 'Synthetic.Api',
        resources: [],
        properties: [],
        strings: {},
        args: {},
        identity: { roles: [] },
        mappings: { tst_row: { entitySet: 'tst_rows' } },
      },
      target,
    );
  });
  const result = await page.evaluate(() =>
    window.context.webAPI.retrieveMultipleRecords('TST_ROW', '?$select=tst_title', 2),
  );
  assert.equal(result.entities[0].tst_title, 'Visible row');
  assert.ok(Object.hasOwn(result, 'nextLink') && result.nextLink === undefined);
  assert.equal(requests[0].url, '/_api/tst_row?$select=tst_title');
  assert.equal(requests[0].headers['pcf-entity-logical-name'], 'tst_row');
  assert.equal(requests[0].headers.__requestverificationtoken, 'fixture-token');
  assert.equal(requests[0].headers.prefer, undefined);
  assert.deepEqual(await page.evaluate(() => window.context.webAPI.createRecord('tst_row', { tst_title: 'New row' })), {
    id: 'd0000000-0000-4000-8000-000000000002',
    entityType: 'tst_row',
  });
  const before = requests.length;
  // Power Pages rejects every webAPI call with undefined; the reason stays in the debugger (inspect().webApiErrors).
  const rejected = await page.evaluate(async () => {
    const failures = [];
    for (const operation of [
      () => window.context.webAPI.retrieveMultipleRecords('tst_row', 'https://example.invalid/data'),
      () => window.context.webAPI.retrieveRecord('tst_row', '../admin', '?$select=tst_title'),
      () => window.context.webAPI.retrieveMultipleRecords('tst_row', '?x=1#fragment'),
    ]) {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    }
    return {
      reasons: failures.map((reason) => reason === undefined),
      messages: window.__paqviloPcf.inspect('api-1')[0].webApiErrors.map((entry) => entry.message),
    };
  });
  assert.deepEqual(rejected.reasons, [true, true, true]);
  assert.deepEqual(rejected.messages, [
    'PCF Web API queries cannot target a different URL',
    'PCF Web API requires a record GUID',
    'PCF Web API options must be an OData or FetchXML query',
  ]);
  assert.equal(requests.length, before);
  // A table that is not mapped locally is still requested by its name, and the portal's refusal rejects with
  // undefined; any maxPageSize, 0 included, is ignored (summary-F section 1).
  assert.deepEqual(
    await page.evaluate(async () => {
      const missing = await window.context.webAPI.retrieveMultipleRecords('missing', '').then(
        () => 'resolved',
        (reason) => reason,
      );
      const ignored = await window.context.webAPI.retrieveMultipleRecords('tst_row', '', 0);
      return { missing: missing === undefined, ignored: ignored.entities.length };
    }),
    { missing: true, ignored: 1 },
  );
  assert.deepEqual(
    requests.slice(before).map((request) => [request.url, request.headers.prefer]),
    [
      ['/_api/missing', undefined],
      ['/_api/tst_row', undefined],
    ],
  );
  assert.deepEqual(
    await page.evaluate(async () => {
      try {
        await window.context.webAPI.retrieveMultipleRecords('tst_row', '?denied=true');
      } catch {
        const { message, errorCode, status } = window.__paqviloPcf.inspect('api-1')[0].webApiErrors.at(-1);
        return { message, code: errorCode, status };
      }
    }),
    { message: 'Fixture permission denied', code: 'AccessDenied', status: 403 },
  );
});
// @test-kind observation: field host outputs are written to the field's hidden input as JSON per type (paqvilo-developer pcf-parity capture r2 notify-save hidden input values)
test('PCF field host outputs are written to the scoped hidden input as JSON in each type encoding', async (t) => {
  const { page } = await hostFixture(t);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate(async () => {
    window.nativeOutputs = {};
    window.dirty = [];
    window.setIsDirty = (id) => window.dirty.push(id);
    window.ComponentFramework.registerControl(
      'Synthetic.Native',
      class {
        init(context, notify, state, container) {
          this.container = container;
          window.nativeContext = context;
          container.addEventListener('output', notify);
        }
        updateView() {}
        getOutputs() {
          return { value: window.nativeOutputs[this.container.dataset.test] };
        }
      },
    );
    const cases = [
      ['text', '"Before"', 'text', 'SingleLine.Text', 'After'],
      ['bool', 'false', 'boolean', 'TwoOptions', true],
      ['choice', '{"Value":1}', 'picklist', 'OptionSet', 2],
      ['multi', '[{"Value":1}]', 'multiselect', 'MultiSelectOptionSet', [2]],
      ['date', '"2026-01-01T00:00:00"', 'datetime', 'DateAndTime.DateOnly', new Date('2026-01-02T00:00:00Z')],
    ];
    for (const [key, hidden, control, type, output] of cases) {
      // Two fields share the id in different cells: each control writes only its own cell's input.
      const cell = document.createElement('div');
      cell.className = 'control';
      cell.dataset.logicalName = key;
      const target = document.createElement('div');
      target.dataset.test = key;
      const input = document.createElement('input');
      input.type = 'hidden';
      input.id = 'native';
      input.value = hidden;
      cell.append(target, input);
      document.body.append(cell);
      window.nativeOutputs[key] = output;
      await window.__paqviloPcf.mount(
        {
          id: key,
          constructor: 'Synthetic.Native',
          resources: [],
          properties: [{ name: 'value', 'of-type': type, usage: 'bound' }],
          strings: {},
          args: {},
          identity: { roles: [] },
          mappings: {},
          nativeBinding: {
            id: 'native',
            control,
            properties: ['value'],
            attributes: {
              LogicalName: key,
              Options: [
                { Label: 'One', Value: 1 },
                { Label: 'Two', Value: 2 },
              ],
            },
          },
          language: { code: 'fr-FR', lcid: 1036, isRTL: false },
        },
        target,
      );
    }
    const written = Promise.all(
      cases.map(
        ([key]) =>
          new Promise((resolve) =>
            document
              .querySelector(`[data-test="${key}"]`)
              .addEventListener('paqvilo:pcf-output', resolve, { once: true }),
          ),
      ),
    );
    for (const [key] of cases) document.querySelector(`[data-test="${key}"]`).dispatchEvent(new Event('output'));
    await written;
  });
  const hidden = (key) => page.locator(`[data-logical-name="${key}"] input[type=hidden]`).inputValue();
  assert.equal(await hidden('text'), '"After"');
  assert.equal(await hidden('bool'), 'true');
  assert.equal(JSON.parse(await hidden('choice')).Value, 2);
  assert.equal(JSON.parse(await hidden('choice')).Label.UserLocalizedLabel.Label, 'Two');
  assert.deepEqual(
    JSON.parse(await hidden('multi')).map((option) => option.Value),
    [2],
  );
  assert.equal(await hidden('date'), '"2026-01-02T00:00:00.000Z"');
  assert.deepEqual(await page.evaluate(() => window.dirty), ['native', 'native', 'native', 'native', 'native']);
  assert.equal(await page.evaluate(() => window.nativeContext.userSettings.languageId), 1036);
  // The default decimal precision is NumberDecimalDigits (2), as formatDecimal(1234.5678) "1,234.57" on a Power Pages site;
  // a page in another language keeps the en-US formatting (paqvilo-developer pcf-parity summary-E de-DE k1/k2).
  assert.equal(await page.evaluate(() => window.nativeContext.formatting.formatDecimal(1234.5)), '1,234.50');
  assert.deepEqual(errors, []);
});
// @test-kind observation: only a value change with a change event on the hidden input reaches the control, with updatedProperties [] (paqvilo-developer pcf-parity capture r2 notify-save script changes)
test('field host script changes reach the control through change events, removed controls detach and runtime failures show their error', async (t) => {
  const { page } = await hostFixture(t);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate(async () => {
    window.syncContexts = {};
    window.syncUpdates = {};
    window.ComponentFramework.registerControl(
      'Synthetic.Sync',
      class {
        init(context, notify, state, container) {
          this.key = container.dataset.test;
          window.syncContexts[this.key] = context;
        }
        updateView(context) {
          window.syncUpdates[this.key] = [...(window.syncUpdates[this.key] ?? []), [...context.updatedProperties]];
        }
        getOutputs() {
          return {};
        }
      },
    );
    for (const [key, type, hidden] of [
      ['text', 'SingleLine.Text', '"Initial"'],
      ['date', 'DateAndTime.DateOnly', '"2026-01-01T00:00:00"'],
      ['multi', 'MultiSelectOptionSet', '[{"Value":1}]'],
    ]) {
      const cell = document.createElement('div');
      cell.className = 'control';
      cell.dataset.logicalName = key;
      const target = document.createElement('div');
      target.dataset.test = key;
      const input = document.createElement('input');
      input.type = 'hidden';
      input.id = 'original';
      input.value = hidden;
      cell.append(target, input);
      document.body.append(cell);
      await window.__paqviloPcf.mount(
        {
          id: key,
          constructor: 'Synthetic.Sync',
          resources: [],
          properties: [{ name: 'value', 'of-type': type, usage: 'bound' }],
          strings: {},
          args: {},
          identity: { roles: [] },
          mappings: {},
          nativeBinding: { id: 'original', control: 'text', properties: ['value'] },
        },
        target,
      );
    }
    const write = (key, value, event = true) => {
      const node = document.querySelector(`[data-logical-name="${key}"] #original`);
      node.value = value;
      if (event) node.dispatchEvent(new Event('change', { bubbles: true }));
    };
    write('text', '"Silent"', false);
    write('text', '"Changed by native script"');
    write('date', '"2026-02-03T00:00:00"');
    write('multi', '[{"Value":2},{"Value":3}]');
  });
  assert.equal(await page.evaluate(() => window.syncContexts.text.parameters.value.raw), 'Changed by native script');
  assert.equal(
    await page.evaluate(() => {
      const raw = window.syncContexts.date.parameters.value.raw;
      return `${raw.getFullYear()}-${raw.getMonth() + 1}-${raw.getDate()}`;
    }),
    '2026-2-3',
  );
  assert.deepEqual(await page.evaluate(() => window.syncContexts.multi.parameters.value.raw), [2, 3]);
  // One updateView at mount and one per change event, each with updatedProperties [].
  assert.deepEqual(await page.evaluate(() => window.syncUpdates), {
    text: [[], []],
    date: [[], []],
    multi: [[], []],
  });
  await page.evaluate(() => {
    window.detachedNative = document.querySelector('[data-logical-name="text"] #original');
    document.querySelector('[data-logical-name="text"]').remove();
  });
  await page.waitForFunction(() => window.__paqviloPcf.inspect().some((item) => item.state === 'destroyed'));
  await page.evaluate(() => {
    window.detachedNative.value = '"Detached value"';
    window.detachedNative.dispatchEvent(new Event('change', { bubbles: true }));
  });
  assert.equal(await page.evaluate(() => window.syncContexts.text.parameters.value.raw), 'Changed by native script');
  await page.evaluate(async () => {
    window.ComponentFramework.registerControl(
      'Synthetic.Broken',
      class {
        init() {
          throw new Error('Fixture runtime failure');
        }
      },
    );
    const cell = document.createElement('div');
    cell.className = 'control';
    cell.dataset.logicalName = 'failed';
    const target = document.createElement('div');
    target.dataset.test = 'failed';
    const input = document.createElement('input');
    input.type = 'hidden';
    input.id = 'original';
    input.value = '"Kept"';
    cell.append(target, input);
    document.body.append(cell);
    await window.__paqviloPcf.mount(
      {
        id: 'failed',
        constructor: 'Synthetic.Broken',
        resources: [],
        properties: [{ name: 'value', 'of-type': 'SingleLine.Text', usage: 'bound' }],
        strings: {},
        args: {},
        identity: { roles: [] },
        mappings: {},
        nativeBinding: { id: 'original', control: 'text', properties: ['value'] },
      },
      target,
    );
  });
  // The hidden input keeps the value the form posts; the control view shows the failure.
  assert.equal(await page.locator('[data-logical-name="failed"] #original').inputValue(), '"Kept"');
  assert.match(await page.locator('[data-test="failed"][role=alert]').innerText(), /Fixture runtime failure/);
  assert.deepEqual(errors, []);
});

test('exported dataset PCF renders real local rows with paging, sorting, filtering, selection and explicit unsupported-filter errors', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-pcf-dataset-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const viewId = 'd0000000-0000-4000-8000-000000000003';
  const portal = path.join(root, 'portal'),
    solution = path.join(root, 'solution');
  const files = {
    'portal/website.yml': 'adx_websiteid: site\nadx_name: Synthetic dataset',
    'portal/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml':
      'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html': `<html><body>{% codecomponent name:tst_Synthetic.Grid rows:'${viewId}' %}</body></html>`,
    'portal/sitesetting.yml':
      '- adx_sitesettingid: api1\n  adx_name: Webapi/tst_row/enabled\n  adx_value: true\n- adx_sitesettingid: api2\n  adx_name: Webapi/tst_row/fields\n  adx_value: tst_rowid,tst_title,tst_when',
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>Synthetic</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/tst_row/Entity.xml':
      '<Entity><Name>tst_row</Name><EntityInfo><entity Name="tst_row"><EntitySetName>tst_rows</EntitySetName><attributes><attribute PhysicalName="tst_rowid"><Name>tst_rowid</Name><LogicalName>tst_rowid</LogicalName><Type>primarykey</Type></attribute><attribute PhysicalName="tst_title"><Name>tst_title</Name><LogicalName>tst_title</LogicalName><Type>nvarchar</Type><DisplayMask>PrimaryName|ValidForForm</DisplayMask></attribute><attribute PhysicalName="tst_when"><Name>tst_when</Name><LogicalName>tst_when</LogicalName><Type>datetime</Type></attribute></attributes></entity></EntityInfo></Entity>',
    [`solution/Entities/tst_row/SavedQueries/${viewId}.xml`]: `<savedquery><savedqueryid>${viewId}</savedqueryid><LocalizedNames><LocalizedName description="Visible Rows" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="tst_row"><attribute name="tst_rowid"/><attribute name="tst_title"/><order attribute="tst_title"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="tst_title" width="200"/></row></grid></layoutxml></savedquery>`,
    'solution/Controls/tst_Synthetic.Grid/ControlManifest.xml':
      '<manifest><control namespace="Synthetic" constructor="Grid" control-type="standard"><data-set name="rows"/><resources><code path="bundle.js"/></resources></control></manifest>',
    'solution/Controls/tst_Synthetic.Grid/ControlManifest.xml.data.xml':
      '<CustomControl><Name>tst_Synthetic.Grid</Name></CustomControl>',
    'solution/Controls/tst_Synthetic.Grid/bundle.js': `ComponentFramework.registerControl('Synthetic.Grid',class{init(context,notify,state,container){window.dataset=context.parameters.rows;this.container=container;dataset.paging.setPageSize(2);}updateView(context){const ds=context.parameters.rows;this.container.dataset.loading=String(ds.loading);this.container.innerHTML='<p class="grid-title"></p><p class="grid-rows"></p><p class="grid-error"></p>';this.container.querySelector('.grid-title').textContent=ds.getTitle();this.container.querySelector('.grid-rows').textContent=ds.sortedRecordIds.map(id=>ds.records[id].getFormattedValue('tst_title')).join(',');this.container.querySelector('.grid-error').textContent=ds.errorMessage;}destroy(){}});`,
  };
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  const app = await createSimulator({
    sourceDir: portal,
    solutionRoots: [solution],
    port: 0,
    watch: false,
    // Paqvilo's local Liquid view binding; Power Pages binds no data set in Liquid (W6 packet 04).
    pcf: { liquidDatasetBinding: 'view' },
    initial: {
      tables: {
        tst_row: ['Alpha', 'Beta', 'Delta', 'Gamma', 'Omega'].map((tst_title, index) => ({
          tst_rowid: 'd1000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'),
          tst_title,
          tst_when: '2026-01-02T00:00:00Z',
        })),
      },
      mappings: { tst_row: { entitySet: 'tst_rows', idColumn: 'tst_rowid', nameColumn: 'tst_title' } },
      permissions: [],
      settings: { permissionMode: 'permissive' },
    },
  });
  const { page, errors, external } = await openPortal(t, app);
  assert.equal(await page.locator('.grid-title').textContent(), 'Visible Rows');
  assert.equal(await page.locator('.grid-rows').textContent(), 'Alpha,Beta');
  assert.equal(await page.evaluate(() => window.dataset.paging.totalResultCount), 5);
  await page.evaluate(() => window.dataset.paging.loadNextPage(true));
  assert.equal(await page.locator('.grid-rows').textContent(), 'Delta,Gamma');
  assert.equal(await page.evaluate(() => window.dataset.paging.hasPreviousPage), true);
  // loadPreviousPage() requests the same page again (live capture summary-C2, Q-092); go back explicitly.
  await page.evaluate(() => window.dataset.paging.loadExactPage(1));
  assert.equal(await page.locator('.grid-rows').textContent(), 'Alpha,Beta');
  await page.evaluate(() => {
    window.dataset.sorting = [{ name: 'tst_title', sortDirection: 1 }];
    return window.dataset.refresh();
  });
  assert.equal(await page.locator('.grid-rows').textContent(), 'Omega,Gamma');
  await page.evaluate(() => {
    window.dataset.filtering.setFilter({
      filterOperator: 0,
      conditions: [{ attributeName: 'tst_title', conditionOperator: 6, value: 'B%' }],
      filters: [],
    });
    return window.dataset.refresh();
  });
  assert.equal(await page.locator('.grid-rows').textContent(), 'Beta');
  assert.equal(await page.evaluate(() => window.dataset.paging.hasNextPage), false);
  const selected = await page.evaluate(() => {
    window.dataset.setSelectedRecordIds([window.dataset.sortedRecordIds[0]]);
    return {
      ids: window.dataset.getSelectedRecordIds(),
      value: window.dataset.records[window.dataset.sortedRecordIds[0]].getValue('tst_title'),
      reference: window.dataset.records[window.dataset.sortedRecordIds[0]].getNamedReference(),
    };
  });
  assert.equal(selected.ids.length, 1);
  assert.equal(selected.value, 'Beta');
  assert.equal(selected.reference.etn, 'tst_row');
  assert.equal(selected.reference.id.guid, selected.ids[0]);
  await page.evaluate(() => {
    window.dataset.filtering.setFilter({
      filterOperator: 0,
      conditions: [{ attributeName: 'tst_title', conditionOperator: 999, value: 'unsupported' }],
      filters: [],
    });
    return window.dataset.refresh();
  });
  assert.match(await page.locator('.grid-error').textContent(), /unsupported/);
  assert.equal(await page.evaluate(() => window.dataset.error), true);
  await page.evaluate(() => {
    window.dataset.filtering.clearFilter();
    window.dataset.clearSelectedRecordIds();
    return window.dataset.refresh();
  });
  assert.equal(await page.locator('.grid-rows').textContent(), 'Omega,Gamma');
  assert.equal(await page.evaluate(() => window.dataset.error), false);
  assert.deepEqual(await page.evaluate(() => window.dataset.getSelectedRecordIds()), []);
  await page.evaluate(() => {
    window.dataset.addColumn('tst_when');
    return window.dataset.refresh();
  });
  assert.equal(
    await page.evaluate(() => window.dataset.columns.find((column) => column.name === 'tst_when').dataType),
    'DateAndTime.DateAndTime',
  );
  assert.equal(
    await page.evaluate(
      () => window.dataset.records[window.dataset.sortedRecordIds[0]].getValue('tst_when') instanceof Date,
    ),
    true,
  );
  const denied = app.store.snapshot();
  denied.settings.permissionMode = 'enforce';
  denied.permissions = [];
  await app.store.replaceState(denied);
  await page.evaluate(() => window.dataset.refresh());
  assert.equal(await page.evaluate(() => window.dataset.error), true);
  assert.match(await page.locator('.grid-error').textContent(), /permission|access/i);
  assert.equal(await page.locator('.grid-rows').textContent(), '');
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});
