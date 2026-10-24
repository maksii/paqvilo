import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readDiscovery } from '../lense/commands/agent.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { createModelDrivenOverlay } from '../lense/model-driven.mjs';
import { startModelDrivenInspector } from '../lense/model-driven-inspector.mjs';
import { modelDrivenInspectorUi } from '../lense/model-driven-inspector-ui.mjs';
import { parseAppActionCommand } from '../mirage/lib/model-driven/solution.mjs';

const formId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const appId = '33333333-3333-4333-8333-333333333333';
const nativeCommandName = '55555555-5555-4555-8555-555555555555!55555555555545558555555555555555';
const nativeCommandId = `inv_item|NoRelationship|Form|${nativeCommandName}`;
const modernCommand = () =>
  parseAppActionCommand(
    `<appaction uniquename="inv__${nativeCommandName}!inv_item!0"><buttonlabeltext default="Review"/><context>1</context><contextentity><logicalname>inv_item</logicalname></contextentity><location>0</location><name>${nativeCommandName}</name><onclickeventjavascriptfunctionname>Invented.review</onclickeventjavascriptfunctionname><onclickeventjavascriptparameters>[]</onclickeventjavascriptparameters><onclickeventjavascriptwebresourceid><webresourceid>aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa</webresourceid></onclickeventjavascriptwebresourceid><onclickeventtype>2</onclickeventtype><type>0</type></appaction>`,
    { webresourcesById: new Map([['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'inv_events.js']]) },
  );
let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

const imported = () => ({
  assets: new Map([
    [
      '/script',
      {
        name: 'inv_events.js',
        file: '/invented/solution/WebResources/inv_events.js',
        mime: 'text/javascript',
        data: Buffer.from(''),
      },
    ],
    [
      '/pcf',
      {
        name: 'inv.Controls.Input/bundle.js',
        file: '/invented/solution/Controls/Input/bundle.js',
        mime: 'text/javascript',
        data: Buffer.from(''),
      },
    ],
  ]),
  resources: [{ name: 'inv_events.js' }],
  diagnostics: [],
  appActions: [
    modernCommand(),
    { ...modernCommand(), entity: 'inv_other', label: 'Other table command' },
    { ...modernCommand(), id: 'inv_grid_command', locations: ['grid'], label: 'Grid command' },
  ],
  layers: [
    {
      documents: [
        {
          file: '/invented/solution/Entities/inv_item/FormXml/main.xml',
          facts: {
            appComponents: {
              forms: [
                {
                  id: formId,
                  entity: 'inv_item',
                  name: 'Invented main',
                  xml: `<form><tabs><tab name="general"><columns><column><sections><section><rows><row><cell><labels><label description="Title" languagecode="1033"/></labels><control id="inv_title" datafieldname="inv_title" uniqueid="control1"/></cell></row></rows></section></sections></column></columns></tab></tabs><formLibraries><Library name="inv_events.js"/></formLibraries><events><event name="onload"><Handlers><Handler libraryName="inv_events.js" functionName="Invented.load" enabled="true"/></Handlers></event><event name="onchange" attribute="inv_title"><Handlers><Handler libraryName="inv_events.js" functionName="Invented.change" enabled="true"/></Handlers></event></events><controlDescriptions><controlDescription forControl="control1"><customControl name="inv.Controls.Input" formFactor="0"><parameters><value type="bound">inv_title</value></parameters></customControl></controlDescription></controlDescriptions></form>`,
                },
              ],
            },
          },
        },
      ],
    },
  ],
});

test(
  'model-driven X-ray binds fields, PCF, handlers and ribbon provenance; bounded agent/debugging remains isolated and read-only',
  { timeout: 60000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-inspector-'));
    const methods = [];
    const server = http.createServer((request, response) => {
      methods.push(request.method);
      if (request.url.startsWith('/missing')) return response.writeHead(404).end('missing');
      response.writeHead(200, { 'content-type': 'text/html' })
        .end(`<!doctype html><title>Invented form</title><style>body{padding:20px}input{width:180px;margin-left:550px}button[data-id]{position:absolute;left:24px;top:36px}</style><h1>Invented form</h1><input data-id="inv_title.fieldControl-text-box-text" value="FORM_VALUE_MUST_NOT_LEAK"/><button data-id="${nativeCommandId}" onpointerdown="window.pointerActivated=true" onmousedown="window.mouseActivated=true" onpointerup="window.pointerReleased=true" onclick="window.reviewed=true">Review</button><script>
      window.Xrm={Utility:{getGlobalContext:()=>({userSettings:{userId:'{${userId}}',userName:'PRIVATE_USER_NAME',roles:{getLength:()=>2}}})},Page:{data:{entity:{getEntityName:()=> 'inv_item',getId:()=>{throw Error('record identity must not be read')}}},ui:{getFormType:()=>2,formSelector:{getCurrentItem:()=>({getId:()=>'{${formId}}'})}}}};
      console.error('token=console-secret');fetch('/missing.js?token=request-secret');
    </script>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext(),
      page = await context.newPage(),
      unrelated = await context.newPage();
    let inspector;
    ownedFixture(t).add(async () => {
      await inspector?.close();
    });
    ownedFixture(t).add(async () => {
      await context.close();
    });
    ownedFixture(t).add(async () => {
      server.closeAllConnections();
    });
    ownedFixture(t).add(async () => {
      await new Promise((resolve) => server.close(resolve));
    });
    ownedFixture(t).remove(async () => {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    const sources = imported(),
      overlay = createModelDrivenOverlay({ origin, imported: sources });
    inspector = await startModelDrivenInspector({
      context,
      page,
      overlay,
      cfg: { origin, stateDir: root, sourceDir: root, siteName: 'invented', envName: 'loopback' },
      imported: sources,
      runtime: { debugPort: 9222 },
    });
    const discovery = await readDiscovery(inspector.agent.discoveryFile);
    assert.equal(discovery.endpoint, inspector.agent.endpoint);
    const call = async (pathname, body) => {
      // The bearer belongs to this test's freshly started agent and is deliberately
      // read from discovery to exercise the real local client authentication flow.
      // The endpoint comes from the owned server, never the discovery file.
      const response = await fetch(inspector.agent.endpoint + pathname, {
        redirect: 'error',
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${discovery.token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, 200);
      return response;
    };
    await unrelated.goto(origin + '/other?token=unrelated-secret');
    await page.goto(origin + '/main.aspx?appid=' + appId + '&etn=inv_item&secret=navigation-secret');
    const host = page.locator('#paqvilo-panel');
    await host.waitFor();
    await page.waitForFunction(() => document.getElementById('paqvilo-panel').__pp);
    await page.keyboard.press('Alt+Shift+P');
    await page.getByRole('tab', { name: 'Inspect', exact: true }).click();
    await page
      .getByText('Only matching exported form IDs establish ownership; table-only matches remain candidates.')
      .waitFor();
    await host.getByRole('button', { name: 'Toggle Lense X-ray', exact: true }).click();
    const fieldBox = await page.locator('input[data-id]').boundingBox();
    await page.mouse.click(fieldBox.x + fieldBox.width / 2, fieldBox.y + fieldBox.height / 2);
    const xray = page.locator('#paqvilo-xray');
    await xray
      .getByRole('complementary', { name: 'Lense source details' })
      .locator('strong')
      .filter({ hasText: /^inv_item\.inv_title$/ })
      .waitFor();
    const panelText = await xray.evaluate((element) => element.shadowRoot.textContent);
    for (const expected of [
      'inv.Controls.Input',
      'Invented.change',
      'Invented.load',
      '/invented/solution/Entities/inv_item/FormXml/main.xml',
    ])
      assert.ok(panelText.includes(expected), expected);
    assert.equal(panelText.includes('FORM_VALUE_MUST_NOT_LEAK'), false);
    if (process.env.PAQVILO_MODEL_INSPECTOR_EVIDENCE)
      await page.screenshot({ path: process.env.PAQVILO_MODEL_INSPECTOR_EVIDENCE });
    const commandBox = await page.locator(`[data-id="${nativeCommandId}"]`).boundingBox();
    await page.mouse.click(commandBox.x + commandBox.width / 2, commandBox.y + commandBox.height / 2);
    await xray.getByText('Declared ribbon command: Review', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => Boolean(window.reviewed)), false);
    assert.deepEqual(
      await page.evaluate(() => [
        Boolean(window.pointerActivated),
        Boolean(window.mouseActivated),
        Boolean(window.pointerReleased),
      ]),
      [false, false, false],
    );
    assert.equal(await xray.getByText('Declared ribbon command: Other table command', { exact: true }).count(), 0);
    assert.equal(await xray.getByText('Declared ribbon command: Grid command', { exact: true }).count(), 0);
    inspector.refresh({ ...sources, appActions: [...sources.appActions, { ...modernCommand(), id: 'inv_duplicate' }] });
    await xray
      .getByText(
        'Multiple declared commands match this native identifier. Command ownership is ambiguous; handlers are not attributed.',
        { exact: true },
      )
      .waitFor();
    assert.equal(await xray.getByText('Declared ribbon command: Review', { exact: true }).count(), 0);
    inspector.refresh(sources);
    await xray.getByText('Declared ribbon command: Review', { exact: true }).waitFor();
    const session = await (await call('/v1/session')).json(),
      pages = await (await call('/v1/pages')).json();
    assert.equal(session.kind, 'model-driven');
    assert.equal(session.debugger.port, 9222);
    assert.equal(pages.pages.length, 1);
    const state = await (await call('/v1/pages/' + pages.pages[0].id + '/state')).json();
    assert.equal(state.context.identity.userId, userId);
    assert.equal(state.context.formId, formId);
    assert.equal(state.context.appId, appId);
    assert.ok(state.problems.some((problem) => problem.type === 'http'));
    assert.ok(state.problems.some((problem) => problem.type === 'error'));
    const serialized = JSON.stringify(state);
    for (const secret of [
      'FORM_VALUE_MUST_NOT_LEAK',
      'PRIVATE_USER_NAME',
      'console-secret',
      'request-secret',
      'navigation-secret',
      'unrelated-secret',
    ])
      assert.equal(serialized.includes(secret), false, secret);
    const dom = await (
      await call('/v1/pages/' + pages.pages[0].id + '/dom', { selector: 'input,#paqvilo-panel', textLimit: 500 })
    ).json();
    assert.equal(dom.elements.length, 1);
    assert.equal(dom.elements[0].text, '');
    assert.equal(JSON.stringify(dom).includes('FORM_VALUE_MUST_NOT_LEAK'), false);
    const image = Buffer.from(await (await call('/v1/pages/' + pages.pages[0].id + '/screenshot', {})).arrayBuffer());
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    await call('/v1/pages/' + pages.pages[0].id + '/navigate', { url: '/main.aspx?etn=inv_item' });
    await page.locator('#paqvilo-panel').waitFor();
    assert.equal(unrelated.url(), origin + '/other?token=unrelated-secret');
    const retiredData = inspector.snapshot();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Debugger.enable');
    await cdp.send('Debugger.pause');
    inspector.refresh();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const stoppingAt = Date.now();
    await inspector.close();
    assert.ok(Date.now() - stoppingAt < 2000, 'A paused debugger must not block inspector disposal');
    await cdp.send('Debugger.resume');
    await cdp.detach();
    await page.waitForFunction(() => !document.getElementById('paqvilo-panel'));
    await page.evaluate(modelDrivenInspectorUi, retiredData);
    assert.equal(await page.locator('#paqvilo-panel').count(), 0);
    await assert.rejects(fs.readFile(inspector.agent.discoveryFile), { code: 'ENOENT' });
    assert.equal(
      methods.some((method) => method !== 'GET'),
      false,
    );
  },
);

test(
  'model-driven X-ray reports delayed refresh, settles pending state and offers retry after inspection errors',
  { timeout: 30000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-inspector-feedback-'));
    const server = http.createServer((_request, response) =>
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<!doctype html><title>Invented app</title><input data-id="inv_title"/>'),
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext({ reducedMotion: 'reduce' }),
      page = await context.newPage();
    let inspector,
      release,
      fail = false,
      block = false;
    ownedFixture(t).add(async () => {
      release?.();
    });
    ownedFixture(t).add(async () => {
      await inspector?.close();
    });
    ownedFixture(t).add(async () => {
      await context.close();
    });
    ownedFixture(t).add(async () => {
      server.closeAllConnections();
    });
    ownedFixture(t).add(async () => {
      await new Promise((resolve) => server.close(resolve));
    });
    ownedFixture(t).remove(async () => {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    await page.goto(origin + '/main.aspx?etn=inv_item');
    const evaluate = page.evaluate.bind(page);
    page.evaluate = async (fn, argument) => {
      if (fn.name === 'inspectModelDrivenContext') {
        if (block)
          await new Promise((resolve) => {
            release = resolve;
          });
        if (fail) {
          fail = false;
          throw Error('Invented context unavailable');
        }
      }
      return evaluate(fn, argument);
    };
    const sources = imported(),
      overlay = createModelDrivenOverlay({ origin, imported: sources });
    inspector = await startModelDrivenInspector({
      context,
      page,
      overlay,
      cfg: { origin, stateDir: root, sourceDir: root, siteName: 'invented', envName: 'loopback' },
      imported: sources,
    });
    const host = page.locator('#paqvilo-panel');
    await host.waitFor();
    await page.waitForFunction(() => document.querySelector('#paqvilo-panel').__pp);
    await page.keyboard.press('Alt+Shift+P');
    await page.getByRole('tab', { name: 'Inspect', exact: true }).click();
    await page
      .getByText('Only matching exported form IDs establish ownership; table-only matches remain candidates.')
      .waitFor();
    const initialBy = Date.now() + 5000;
    while (inspector.snapshot().pendingInspection && Date.now() < initialBy)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(inspector.snapshot().pendingInspection, false, 'initial context settled');
    block = true;
    inspector.refresh();
    const waitDeadline = Date.now() + 5000;
    while (!release && Date.now() < waitDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    await host.getByText('Updating source inspection…', { exact: true }).waitFor();
    assert.equal(inspector.snapshot().pendingInspection, true);
    if (process.env.PAQVILO_MODEL_FEEDBACK_EVIDENCE)
      await page.screenshot({ path: process.env.PAQVILO_MODEL_FEEDBACK_EVIDENCE });
    block = false;
    assert.ok(release);
    release();
    const finishBy = Date.now() + 5000;
    while (inspector.snapshot().pendingInspection && Date.now() < finishBy)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(inspector.snapshot().pendingInspection, false);
    fail = true;
    inspector.refresh();
    const errorBy = Date.now() + 5000;
    while (!inspector.snapshot().inspectionError && Date.now() < errorBy)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(inspector.snapshot().inspectionError, /could not be refreshed/);
    inspector.refresh();
    const retryBy = Date.now() + 5000;
    while ((inspector.snapshot().pendingInspection || inspector.snapshot().inspectionError) && Date.now() < retryBy)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(inspector.snapshot().inspectionError, '');
    assert.equal(inspector.snapshot().pendingInspection, false);
  },
);
