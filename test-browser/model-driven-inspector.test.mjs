import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createModelDrivenOverlay } from '../lense/model-driven.mjs';
import { startModelDrivenInspector } from '../lense/model-driven-inspector.mjs';
import { modelDrivenInspectorUi } from '../lense/model-driven-inspector-ui.mjs';
import { parseAppActionCommand } from '../mirage/lib/model-driven/solution.mjs';

const formId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const appId = '33333333-3333-4333-8333-333333333333';
const nativeCommandName = '55555555-5555-4555-8555-555555555555!55555555555545558555555555555555';
const nativeCommandId = `inv_item|NoRelationship|Form|${nativeCommandName}`;
const modernCommand = () => parseAppActionCommand(`<appaction uniquename="inv__${nativeCommandName}!inv_item!0"><buttonlabeltext default="Review"/><context>1</context><contextentity><logicalname>inv_item</logicalname></contextentity><location>0</location><name>${nativeCommandName}</name><onclickeventjavascriptfunctionname>Invented.review</onclickeventjavascriptfunctionname><onclickeventjavascriptparameters>[]</onclickeventjavascriptparameters><onclickeventjavascriptwebresourceid><webresourceid>aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa</webresourceid></onclickeventjavascriptwebresourceid><onclickeventtype>2</onclickeventtype><type>0</type></appaction>`, { webresourcesById: new Map([['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'inv_events.js']]) });
const imported = () => ({ assets: new Map([
  ['/script', { name: 'inv_events.js', file: '/invented/solution/WebResources/inv_events.js', mime: 'text/javascript', data: Buffer.from('') }],
  ['/pcf', { name: 'inv.Controls.Input/bundle.js', file: '/invented/solution/Controls/Input/bundle.js', mime: 'text/javascript', data: Buffer.from('') }],
]), resources: [{ name: 'inv_events.js' }], diagnostics: [], appActions: [modernCommand(), { ...modernCommand(), entity: 'inv_other', label: 'Other table command' }, { ...modernCommand(), id: 'inv_grid_command', locations: ['grid'], label: 'Grid command' }],
  layers: [{ documents: [{ file: '/invented/solution/Entities/inv_item/FormXml/main.xml', facts: { appComponents: { forms: [{ id: formId, entity: 'inv_item', name: 'Invented main', xml: `<form><tabs><tab name="general"><columns><column><sections><section><rows><row><cell><labels><label description="Title" languagecode="1033"/></labels><control id="inv_title" datafieldname="inv_title" uniqueid="control1"/></cell></row></rows></section></sections></column></columns></tab></tabs><formLibraries><Library name="inv_events.js"/></formLibraries><events><event name="onload"><Handlers><Handler libraryName="inv_events.js" functionName="Invented.load" enabled="true"/></Handlers></event><event name="onchange" attribute="inv_title"><Handlers><Handler libraryName="inv_events.js" functionName="Invented.change" enabled="true"/></Handlers></event></events><controlDescriptions><controlDescription forControl="control1"><customControl name="inv.Controls.Input" formFactor="0"><parameters><value type="bound">inv_title</value></parameters></customControl></controlDescription></controlDescriptions></form>` }] } } }] }],
});

test('model-driven X-ray binds fields, PCF, handlers and ribbon provenance; bounded agent/debugging remains isolated and read-only', { timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-inspector-'));
  const methods = [];
  const server = http.createServer((request, response) => {
    methods.push(request.method);
    if (request.url.startsWith('/missing')) return response.writeHead(404).end('missing');
    response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Invented form</title><style>body{padding:20px}input{width:180px;margin-left:550px}button[data-id]{position:absolute;left:24px;top:36px}</style><h1>Invented form</h1><input data-id="inv_title.fieldControl-text-box-text" value="FORM_VALUE_MUST_NOT_LEAK"/><button data-id="${nativeCommandId}" onpointerdown="window.pointerActivated=true" onmousedown="window.mouseActivated=true" onpointerup="window.pointerReleased=true" onclick="window.reviewed=true">Review</button><script>
      window.Xrm={Utility:{getGlobalContext:()=>({userSettings:{userId:'{${userId}}',userName:'PRIVATE_USER_NAME',roles:{getLength:()=>2}}})},Page:{data:{entity:{getEntityName:()=> 'inv_item',getId:()=>{throw Error('record identity must not be read')}}},ui:{getFormType:()=>2,formSelector:{getCurrentItem:()=>({getId:()=>'{${formId}}'})}}}};
      console.error('token=console-secret');fetch('/missing.js?token=request-secret');
    </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  const browser = await chromium.launch({ channel: channel === 'chromium' ? undefined : channel, headless: true });
  const context = await browser.newContext(), page = await context.newPage(), unrelated = await context.newPage();
  let inspector;
  t.after(async () => { await inspector?.close(); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const sources = imported(), overlay = createModelDrivenOverlay({ origin, imported: sources });
  inspector = await startModelDrivenInspector({ context, page, overlay, cfg: { origin, stateDir: root, sourceDir: root, siteName: 'invented', envName: 'loopback' }, imported: sources, runtime: { debugPort: 9222 } });
  const discovery = JSON.parse(await fs.readFile(inspector.agent.discoveryFile, 'utf8'));
  const call = async (pathname, body) => {
    // The bearer belongs to this test's freshly started agent and is deliberately
    // read from discovery to exercise the real local client authentication flow.
    // The endpoint comes from the owned server, never the discovery file.
    const response = await fetch(inspector.agent.endpoint + pathname, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${discovery.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200); return response;
  };
  await unrelated.goto(origin + '/other?token=unrelated-secret');
  await page.goto(origin + '/main.aspx?appid=' + appId + '&etn=inv_item&secret=navigation-secret');
  const host = page.locator('#paqvilo-model-inspector'); await host.waitFor();
  await page.getByRole('button', { name: 'Model-driven developer panel' }).click();
  await page.getByRole('button', { name: 'X-ray', exact: true }).click();
  await page.locator('input').click();
  await page.getByText('Current native form ID matched: Invented main', { exact: true }).waitFor();
  const details = await host.innerText(); // Shadow text intentionally requires an explicit shadow query below.
  assert.equal(details.includes('FORM_VALUE_MUST_NOT_LEAK'), false);
  const panelText = await host.evaluate(element => element.shadowRoot.textContent);
  for (const expected of ['Column: inv_title', 'PCF: inv.Controls.Input', 'Invented.change', 'Invented.load', '/invented/solution/Entities/inv_item/FormXml/main.xml', 'requires an exact', 'roles: 2']) assert.ok(panelText.toLowerCase().includes(expected.toLowerCase()), expected + '\n' + panelText);
  await host.locator('.outline').waitFor({ state: 'visible' });
  if (process.env.PAQVILO_MODEL_INSPECTOR_EVIDENCE) await page.screenshot({ path: process.env.PAQVILO_MODEL_INSPECTOR_EVIDENCE });
  await page.evaluate(() => { window.Xrm.Page.ui.formSelector.getCurrentItem = () => ({ getId: () => '44444444-4444-4444-8444-444444444444' }); });
  inspector.refresh();
  await page.getByText('Candidate form matched by table; current native form is absent from selected sources: Invented main', { exact: true }).waitFor();
  await page.evaluate(id => { window.Xrm.Page.ui.formSelector.getCurrentItem = () => ({ getId: () => id }); }, formId);
  inspector.refresh();
  await page.getByText('Current native form ID matched: Invented main', { exact: true }).waitFor();
  assert.equal(await page.locator(`[data-id="${nativeCommandId}"]`).evaluate(node => {
    const rect = node.getBoundingClientRect();
    return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.id === 'paqvilo-model-inspector';
  }), true, 'Fixture command is behind the long details card before picking');
  await page.getByRole('button', { name: 'X-ray', exact: true }).click();
  assert.equal(await host.locator('.panel').isVisible(), false, 'Picking temporarily hides details so covered native targets are reachable');
  await page.locator(`[data-id="${nativeCommandId}"]`).click();
  assert.equal(await page.evaluate(() => Boolean(window.reviewed)), false, 'X-ray must prevent native command execution when selecting');
  assert.deepEqual(await page.evaluate(() => [Boolean(window.pointerActivated), Boolean(window.mouseActivated), Boolean(window.pointerReleased)]), [false, false, false], 'X-ray must also prevent native pointer and mouse activation');
  await page.getByText('Declared ribbon command: Review', { exact: true }).waitFor();
  assert.equal(await host.locator('.panel').isVisible(), true, 'Details return after selecting the previously covered native command');
  assert.equal(await page.getByText('Declared ribbon command: Other table command', { exact: true }).count(), 0, 'Shared command IDs from another table must not be attributed to this form');
  assert.equal(await page.getByText('Declared ribbon command: Grid command', { exact: true }).count(), 0, 'Grid aliases cannot claim a form command');
  inspector.refresh({ ...sources, appActions: [...sources.appActions, { ...modernCommand(), id: 'inv_duplicate' }] });
  await page.getByText('Multiple declared commands match this native identifier. Command ownership is ambiguous; handlers are not attributed.', { exact: true }).waitFor();
  assert.equal(await page.getByText('Declared ribbon command: Review', { exact: true }).count(), 0);
  inspector.refresh(sources);
  await page.getByText('Declared ribbon command: Review', { exact: true }).waitFor();
  const session = await (await call('/v1/session')).json(), pages = await (await call('/v1/pages')).json();
  assert.equal(session.kind, 'model-driven'); assert.equal(session.debugger.port, 9222); assert.equal(pages.pages.length, 1);
  const state = await (await call('/v1/pages/' + pages.pages[0].id + '/state')).json();
  assert.equal(state.context.identity.userId, userId); assert.equal(state.context.formId, formId); assert.equal(state.context.appId, appId);
  assert.ok(state.problems.some(problem => problem.type === 'http')); assert.ok(state.problems.some(problem => problem.type === 'error'));
  const serialized = JSON.stringify(state);
  for (const secret of ['FORM_VALUE_MUST_NOT_LEAK', 'PRIVATE_USER_NAME', 'console-secret', 'request-secret', 'navigation-secret', 'unrelated-secret']) assert.equal(serialized.includes(secret), false, secret);
  const dom = await (await call('/v1/pages/' + pages.pages[0].id + '/dom', { selector: 'input,#paqvilo-model-inspector', textLimit: 500 })).json();
  assert.equal(dom.elements.length, 1); assert.equal(dom.elements[0].text, ''); assert.equal(JSON.stringify(dom).includes('FORM_VALUE_MUST_NOT_LEAK'), false);
  const image = Buffer.from(await (await call('/v1/pages/' + pages.pages[0].id + '/screenshot', {})).arrayBuffer());
  assert.deepEqual([...image.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  await call('/v1/pages/' + pages.pages[0].id + '/navigate', { url: '/main.aspx?etn=inv_item' }); await page.locator('#paqvilo-model-inspector').waitFor();
  assert.equal(unrelated.url(), origin + '/other?token=unrelated-secret');
  const retiredData = inspector.snapshot();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Debugger.enable'); await cdp.send('Debugger.pause');
  inspector.refresh(); await new Promise(resolve => setTimeout(resolve, 150));
  const stoppingAt = Date.now();
  await inspector.close();
  assert.ok(Date.now() - stoppingAt < 2000, 'A paused debugger must not block inspector disposal');
  await cdp.send('Debugger.resume'); await cdp.detach();
  await page.waitForFunction(() => !document.getElementById('paqvilo-model-inspector'));
  await page.evaluate(modelDrivenInspectorUi, retiredData);
  assert.equal(await page.locator('#paqvilo-model-inspector').count(), 0); await assert.rejects(fs.readFile(inspector.agent.discoveryFile));
  assert.equal(methods.some(method => method !== 'GET'), false);
});

test('model-driven X-ray reports delayed refresh, settles pending state and offers retry after inspection errors', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-inspector-feedback-'));
  const server = http.createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Invented app</title><input data-id="inv_title"/>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
  const context = await browser.newContext({ reducedMotion: 'reduce' }), page = await context.newPage();
  let inspector, release, fail = false, block = false;
  t.after(async () => { release?.(); await inspector?.close(); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  await page.goto(origin + '/main.aspx?etn=inv_item');
  const evaluate = page.evaluate.bind(page);
  page.evaluate = async (fn, argument) => {
    if (fn.name === 'inspectModelDrivenContext') {
      if (block) await new Promise(resolve => { release = resolve; });
      if (fail) { fail = false; throw Error('Invented context unavailable'); }
    }
    return evaluate(fn, argument);
  };
  const sources = imported(), overlay = createModelDrivenOverlay({ origin, imported: sources });
  inspector = await startModelDrivenInspector({ context, page, overlay, cfg: { origin, stateDir: root, sourceDir: root, siteName: 'invented', envName: 'loopback' }, imported: sources });
  const host = page.locator('#paqvilo-model-inspector'); await host.waitFor();
  await page.waitForFunction(() => document.querySelector('#paqvilo-model-inspector').shadowRoot.querySelector('.panel').getAttribute('aria-busy') === 'false');
  block = true;
  await page.getByRole('button', { name: 'Model-driven developer panel' }).click();
  await host.locator('.status').filter({ hasText: 'Reading app context' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Refreshing…', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'X-ray', exact: true }).click();
  await host.locator('.scan.active').waitFor({ state: 'visible' });
  assert.equal(await host.locator('.scan').evaluate(node => getComputedStyle(node).pointerEvents), 'none');
  await page.waitForFunction(() => document.querySelector('#paqvilo-model-inspector').shadowRoot.querySelector('.bar-status').textContent === 'Inspecting app…');
  while (!release) await new Promise(resolve => setTimeout(resolve, 10));
  if (process.env.PAQVILO_MODEL_FEEDBACK_EVIDENCE) await page.screenshot({ path: process.env.PAQVILO_MODEL_FEEDBACK_EVIDENCE });
  block = false; release();
  await page.waitForFunction(() => document.querySelector('#paqvilo-model-inspector').shadowRoot.querySelector('.panel').getAttribute('aria-busy') === 'false');
  assert.equal(inspector.snapshot().pendingInspection, false);
  await page.keyboard.press('Escape');
  fail = true; await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'App context could not be refreshed' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Refresh', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForFunction(() => { const panel = document.querySelector('#paqvilo-model-inspector').shadowRoot.querySelector('.panel'); return panel.getAttribute('aria-busy') === 'false' && !panel.querySelector('[role=alert]'); });
});
