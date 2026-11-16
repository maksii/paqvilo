// @test-kind contract: model-driven inspector tests run on owned loopback fixtures with the agent ownership the command gives them.
import { makeTemporaryDirectory, ownedFixture } from '../mirage/testing/owned-fixture.mjs';

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
import { startAgentServer } from '../lense/agent-server.mjs';
import { EventEmitter } from 'node:events';
import { modelDrivenInspectorUi } from '../lense/model-driven-inspector-ui.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';
import { panelUi } from '../lense/panel-ui.mjs';
import { parseAppActionCommand } from '../mirage/lib/model-driven/solution.mjs';
import { createHash } from 'node:crypto';
import { inspectModelDrivenContext } from '../lense/model-driven-inspection.mjs';

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

// Closes the page context and the fixture server, and removes the fixture root, when the test ends.
function ownContextServerRoot(t, context, server, root) {
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
}

// Records the guards an inspector arms. A guard expires only when the test calls its expire(); an operation that
// settles cancels its guard, which the record shows.
function guardScheduler() {
  const guards = [];
  let notify = () => {};
  const open = (since) => guards.slice(since).filter((guard) => !guard.cancelled);
  return {
    armed: () => guards.length,
    scheduleGuard(expire, ms) {
      const guard = { ms, expire, cancelled: false };
      guards.push(guard);
      notify();
      return () => {
        guard.cancelled = true;
      };
    },
    // Resolves with the guards armed from index since that are still pending, once there are at least count of them.
    async pending(count, since) {
      while (open(since).length < count)
        await new Promise((resolve) => {
          notify = resolve;
        });
      return open(since);
    },
  };
}

test('model-driven X-ray binds fields, PCF, handlers and ribbon provenance; bounded agent/debugging remains isolated and read-only', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'model-inspector-'));
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
  let inspector, agent;
  ownedFixture(t).add(async () => {
    await inspector?.close();
  });
  ownedFixture(t).add(async () => {
    await agent?.close();
  });
  ownContextServerRoot(t, context, server, root);
  const sources = imported();
  const document = sources.layers[0].documents[0],
    xml = document.facts.appComponents.forms[0].xml;
  const sourcePath = path.join(root, 'solution/Entities/inv_item/FormXml/main.xml');
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, xml);
  const formSource = await fs.realpath(sourcePath);
  document.file = formSource;
  sources.metadata = { sourceRevisions: { [formSource]: createHash('sha256').update(xml).digest('hex') } };
  const overlay = createModelDrivenOverlay({ origin, imported: sources });
  // No guard expires on its own: healthy reads have no deadline, and the paused page below expires its own guards.
  const guards = guardScheduler();
  inspector = await startModelDrivenInspector({
    context,
    page,
    overlay,
    cfg: { origin, stateDir: root, sourceDir: root, siteName: 'invented', envName: 'loopback' },
    imported: sources,
    nativeReadGuardMs: 5000,
    scheduleGuard: guards.scheduleGuard,
    runtime: { debugPort: 9222 },
  });
  // The command starts one agent per dev session and attaches each inspector's state to it.
  agent = await startAgentServer({
    session: Object.assign(new EventEmitter(), {
      cfg: { stateDir: root, origin, siteName: 'invented', envName: 'loopback', sourceDir: root },
      rel: String,
    }),
    context,
    stop: () => {},
    runtime: { watching: true, debugPort: 9222 },
    options: { deferred: true, ownsPage: (candidate) => candidate === page },
  });
  agent.setInspector(inspector.agentState);
  const discovery = await readDiscovery(agent.discoveryFile);
  assert.equal(discovery.endpoint, agent.endpoint);
  const call = async (pathname, body) => {
    // The bearer belongs to this test's freshly started agent and is deliberately
    // read from discovery to exercise the real local client authentication flow.
    // The endpoint comes from the owned server, never the discovery file.
    const response = await fetch(agent.endpoint + pathname, {
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
  // The page fetches a missing script and does not wait for it, so the load can end before its answer. The inspector
  // records the HTTP problem that the session state is checked for from this response.
  const missing = page.waitForResponse((response) => new URL(response.url()).pathname === '/missing.js');
  await page.goto(origin + '/main.aspx?appid=' + appId + '&etn=inv_item&secret=navigation-secret');
  await missing;
  const host = page.locator('#paqvilo-panel');
  await host.waitFor();
  await page.waitForFunction(() => document.getElementById('paqvilo-panel').__pp);
  await page.keyboard.press('Alt+Shift+P');
  await page.getByRole('tab', { name: 'Inspect', exact: true }).click();
  await page
    .getByText(
      'Selected element ownership and local source identity are evaluated separately from native form context.',
    )
    .waitFor();
  await host.getByRole('button', { name: 'Toggle Lense X-ray', exact: true }).click();
  const fieldBox = await page.locator('input[data-id]').boundingBox();
  await page.mouse.click(fieldBox.x + fieldBox.width / 2, fieldBox.y + fieldBox.height / 2);
  const xray = page.locator('#paqvilo-xray');
  await xray
    .locator('[data-inspection-evidence][data-owner-status="candidate"][data-source-status="candidate"]')
    .waitFor();
  const selected = await page.evaluate(
    () => document.getElementById('paqvilo-xray').__px.selectionState().identity.evidence,
  );
  assert.ok(selected.candidates.some((item) => item.component.controlName === 'inv_title'));
  assert.ok(
    selected.source.refs.some(
      (ref) =>
        ref.ref === formSource &&
        ref.region?.line &&
        ref.contentRevision === createHash('sha256').update(xml).digest('hex'),
    ),
    'a native DOM candidate retains its current real exported definition without claiming execution',
  );
  await xray.getByText('inv.Controls.Input', { exact: true }).first().waitFor({ state: 'attached' });
  const panelText = await xray.evaluate((element) => element.shadowRoot.textContent);
  for (const expected of ['inv.Controls.Input', 'Invented.change', 'Invented.load', formSource])
    assert.ok(panelText.includes(expected), expected);
  assert.equal(panelText.includes('FORM_VALUE_MUST_NOT_LEAK'), false);
  if (process.env.PAQVILO_MODEL_INSPECTOR_EVIDENCE)
    await page.screenshot({ path: process.env.PAQVILO_MODEL_INSPECTOR_EVIDENCE });
  const commandBox = await page.locator(`[data-id="${nativeCommandId}"]`).boundingBox();
  await page.mouse.click(commandBox.x + commandBox.width / 2, commandBox.y + commandBox.height / 2);
  await page.waitForFunction(() =>
    document
      .getElementById('paqvilo-xray')
      .__px.selectionState()
      .identity.evidence.candidates.some(
        (item) => item.component.kind === 'command' && item.component.label === 'Review',
      ),
  );
  let commandEvidence = await page.evaluate(
    () => document.getElementById('paqvilo-xray').__px.selectionState().identity.evidence,
  );
  assert.equal(
    commandEvidence.owner.status,
    'candidate',
    'an exported DOM identifier does not prove native command execution',
  );
  assert.equal(
    commandEvidence.source.status,
    'unavailable',
    'this fixture supplies parsed AppAction declarations without an AppAction source file/hash',
  );
  assert.equal(await page.evaluate(() => Boolean(window.reviewed)), false);
  assert.deepEqual(
    await page.evaluate(() => [
      Boolean(window.pointerActivated),
      Boolean(window.mouseActivated),
      Boolean(window.pointerReleased),
    ]),
    [false, false, false],
  );
  assert.deepEqual(
    commandEvidence.candidates.filter((item) => item.component.kind === 'command').map((item) => item.component.label),
    ['Review'],
  );
  inspector.refresh({ ...sources, appActions: [...sources.appActions, { ...modernCommand(), id: 'inv_duplicate' }] });
  await page.waitForFunction(
    () =>
      document
        .getElementById('paqvilo-xray')
        .__px.selectionState()
        .identity.evidence.candidates.filter((item) => item.component.kind === 'command').length === 2,
  );
  commandEvidence = await page.evaluate(
    () => document.getElementById('paqvilo-xray').__px.selectionState().identity.evidence,
  );
  assert.equal(commandEvidence.owner.status, 'candidate');
  assert.ok(
    commandEvidence.candidates.every((item) => item.status === 'candidate'),
    'duplicate identifier declarations remain candidates',
  );
  inspector.refresh(sources);
  await page.waitForFunction(
    () =>
      document
        .getElementById('paqvilo-xray')
        .__px.selectionState()
        .identity.evidence.candidates.filter((item) => item.component.kind === 'command').length === 1,
  );
  const session = await (await call('/v1/session')).json(),
    pages = await (await call('/v1/pages')).json();
  assert.equal(session.kind, 'model-driven');
  assert.equal(session.debugger.port, 9222);
  assert.equal(pages.pages.length, 1);
  const state = await (await call('/v1/pages/' + pages.pages[0].id + '/state')).json();
  assert.equal(state.context.identity, undefined, 'source inspection does not export signed-in user identity');
  assert.equal(state.context.formId, formId);
  assert.equal(state.context.appId, undefined, 'navigation query input is not observed app identity');
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
    userId,
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
  // The scheduled refresh runs page JavaScript, which pauses; close while it is held there.
  const paused = new Promise((resolve) => cdp.once('Debugger.paused', resolve));
  await cdp.send('Debugger.pause');
  inspector.refresh();
  await paused;
  // The debugger resumes only after close settles. Close arms one guard per cleanup call on the paused page; each
  // pending guard is expired here, which abandons its call and records the abandonment in the session log.
  // The owner detaches the inspector from the agent before retiring it, as the target session does.
  agent.setInspector(null);
  const armedBeforeClose = guards.armed();
  const closing = inspector.close();
  for (const guard of await guards.pending(2, armedBeforeClose)) guard.expire();
  await closing;
  const leaks = inspector.snapshot().problems.filter((item) => item.code === 'cleanup-timed-out');
  assert.ok(
    leaks.some((item) => item.text.startsWith('Owned provider disposal did not answer within 5000 ms')),
    'the paused provider disposal is recorded as abandoned',
  );
  assert.ok(
    leaks.some((item) => item.text.startsWith('Panel inspector retirement did not answer within 5000 ms')),
    'the paused panel retirement is recorded as abandoned',
  );
  await cdp.send('Debugger.resume');
  await cdp.detach();
  await page.waitForFunction(() => !document.getElementById('paqvilo-panel'));
  await page.evaluate(modelDrivenInspectorUi, retiredData);
  assert.equal(await page.locator('#paqvilo-panel').count(), 0);
  // Retiring the inspector keeps the session's discovery file; the agent's own close removes it.
  assert.equal(
    (await fs.readdir(path.dirname(agent.discoveryFile))).includes(path.basename(agent.discoveryFile)),
    true,
    'retiring the inspector keeps the discovery file',
  );
  assert.equal((await (await call('/v1/session')).json()).inspection.suspended, true);
  assert.equal(
    methods.some((method) => method !== 'GET'),
    false,
  );
  await agent.close();
  await assert.rejects(fs.readFile(agent.discoveryFile), { code: 'ENOENT' });
});

test('model-driven X-ray reports delayed refresh, settles pending state and offers retry after inspection errors', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'model-inspector-feedback-'));
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
    blocked,
    fail = false,
    block = false;
  const inspectionBlocked = new Promise((resolve) => {
    blocked = resolve;
  });
  // The inspector publishes no change event. Every change of its pending or error state is followed by a panel draw,
  // which is a page call, so the snapshot is read again at each page call until it shows the expected state.
  const waiting = new Set();
  const settled = (ready) =>
    new Promise((resolve) => {
      const check = () => {
        const state = inspector.snapshot();
        if (!ready(state)) return;
        waiting.delete(check);
        resolve(state);
      };
      waiting.add(check);
      check();
    });
  ownedFixture(t).add(async () => {
    release?.();
  });
  ownedFixture(t).add(async () => {
    await inspector?.close();
  });
  ownContextServerRoot(t, context, server, root);
  await page.goto(origin + '/main.aspx?etn=inv_item');
  const evaluate = page.evaluate.bind(page);
  page.evaluate = async (fn, argument) => {
    for (const check of [...waiting]) check();
    if (fn === inspectModelDrivenContext) {
      if (block)
        await new Promise((resolve) => {
          release = resolve;
          blocked();
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
    .getByText(
      'Selected element ownership and local source identity are evaluated separately from native form context.',
    )
    .waitFor();
  assert.equal(
    (await settled((state) => !state.pendingInspection)).pendingInspection,
    false,
    'initial context settled',
  );
  block = true;
  inspector.refresh();
  await inspectionBlocked;
  await host.getByText('Updating source inspection…', { exact: true }).waitFor();
  assert.equal(inspector.snapshot().pendingInspection, true);
  if (process.env.PAQVILO_MODEL_FEEDBACK_EVIDENCE)
    await page.screenshot({ path: process.env.PAQVILO_MODEL_FEEDBACK_EVIDENCE });
  block = false;
  release();
  assert.equal((await settled((state) => !state.pendingInspection)).pendingInspection, false);
  fail = true;
  inspector.refresh();
  assert.match((await settled((state) => state.inspectionError)).inspectionError, /could not be refreshed/);
  inspector.refresh();
  const retried = await settled((state) => !state.pendingInspection && !state.inspectionError);
  assert.equal(retried.inspectionError, '');
  assert.equal(retried.pendingInspection, false);
});

test('retiring a session removes the panel it drew before the panel inspector adopted it', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'model-inspector-retire-'));
  const server = http.createServer((_request, response) =>
    response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Invented app</title>'),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext(),
    page = await context.newPage();
  let inspector, held, release, adopted;
  const adoptionHeld = new Promise((resolve) => {
    held = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const adoptionAnswered = new Promise((resolve) => {
    adopted = resolve;
  });
  ownedFixture(t).add(async () => {
    release();
  });
  ownedFixture(t).add(async () => {
    await inspector?.close();
  });
  ownContextServerRoot(t, context, server, root);
  await page.goto(origin + '/main.aspx?etn=inv_item');
  // The adoption call waits at the gate, so the session is retired after its panel is drawn and before the panel
  // inspector adopts it. A page paused in a debugger at the adoption call runs the retirement in the same order.
  const evaluate = page.evaluate.bind(page);
  page.evaluate = async (fn, argument) => {
    if (fn !== modelDrivenInspectorUi) return evaluate(fn, argument);
    held();
    await gate;
    try {
      return await evaluate(fn, argument);
    } finally {
      adopted();
    }
  };
  const sources = imported();
  inspector = await startModelDrivenInspector({
    context,
    page,
    overlay: createModelDrivenOverlay({ origin, imported: sources }),
    cfg: { origin, stateDir: root, sourceDir: root, siteName: 'invented', envName: 'loopback' },
    imported: sources,
  });
  await adoptionHeld;
  assert.equal(
    await evaluate(() => Boolean(document.getElementById('paqvilo-panel')?.__pp)),
    true,
    'the panel is drawn before its inspector is adopted',
  );
  await inspector.close();
  assert.equal(await page.locator('#paqvilo-panel').count(), 0, 'retirement removes the panel that was not adopted');
  release();
  await adoptionAnswered;
  assert.equal(await page.locator('#paqvilo-panel').count(), 0, 'the late adoption does not restore the panel');
});

test('retiring a session disposes its panel and X-ray after the page removed their hosts from the document', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'model-inspector-orphan-'));
  const server = http.createServer((_request, response) =>
    response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Invented app</title>'),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext(),
    page = await context.newPage();
  let inspector;
  ownedFixture(t).add(async () => {
    await inspector?.close();
  });
  ownContextServerRoot(t, context, server, root);
  await page.goto(origin + '/main.aspx?etn=inv_item');
  const sources = imported();
  inspector = await startModelDrivenInspector({
    context,
    page,
    overlay: createModelDrivenOverlay({ origin, imported: sources }),
    cfg: { origin, stateDir: root, sourceDir: root, siteName: 'invented', envName: 'loopback' },
    imported: sources,
  });
  // The live panel and X-ray of the realm, by their registries: a host the page removed is found through neither id.
  const live = () =>
    page.evaluate(() => ({
      panel: Boolean(globalThis.__paqviloPanelUi),
      xray: Boolean(globalThis.__paqviloXrayUi),
      hosts: document.querySelectorAll('#paqvilo-panel, #paqvilo-xray').length,
    }));
  await page.waitForFunction(() => Boolean(globalThis.__paqviloPanelUi) && Boolean(globalThis.__paqviloXrayUi));
  // A single-page app that replaces its body takes both hosts out of the document without ending the session.
  await page.evaluate(() => {
    for (const id of ['paqvilo-panel', 'paqvilo-xray']) document.getElementById(id)?.remove();
  });
  // The X-ray watches its own host and may already have gone with it; the panel has no such watch.
  const orphaned = await live();
  assert.deepEqual([orphaned.panel, orphaned.hosts], [true, 0], 'the panel code is live without its host');
  await inspector.close();
  assert.deepEqual(await live(), { panel: false, xray: false, hosts: 0 }, 'retirement disposed the orphaned page code');
});

test('a draw in progress when the inspector closes stops before its next page call', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'model-inspector-late-draw-'));
  const server = http.createServer((_request, response) =>
    response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Invented app</title>'),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext(),
    page = await context.newPage();
  let inspector, drawn, release, passed;
  const panelDrawn = new Promise((resolve) => {
    drawn = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const drawPassed = new Promise((resolve) => {
    passed = resolve;
  });
  ownedFixture(t).add(async () => {
    release();
  });
  ownedFixture(t).add(async () => {
    await inspector?.close();
  });
  ownContextServerRoot(t, context, server, root);
  await page.goto(origin + '/main.aspx?etn=inv_item');
  // The answer of the first panel call waits at the gate, so the inspector closes and the page shows another document
  // between two page calls of one draw. The context read is the first call after a draw.
  const evaluate = page.evaluate.bind(page);
  const called = [];
  let held = false;
  page.evaluate = async (fn, argument) => {
    called.push(fn);
    if (fn === inspectModelDrivenContext) passed();
    const answer = await evaluate(fn, argument);
    if (fn === panelUi && !held) {
      held = true;
      drawn();
      await gate;
    }
    return answer;
  };
  const sources = imported();
  inspector = await startModelDrivenInspector({
    context,
    page,
    overlay: createModelDrivenOverlay({ origin, imported: sources }),
    cfg: { origin, stateDir: root, sourceDir: root, siteName: 'invented', envName: 'loopback' },
    imported: sources,
  });
  await panelDrawn;
  await inspector.close();
  await page.goto(origin + '/main.aspx?etn=inv_item&document=2');
  release();
  await drawPassed;
  assert.equal(called.includes(xrayUi), false, 'the closed inspector makes no further draw call');
  assert.deepEqual(
    await evaluate(() => ['paqvilo-panel', 'paqvilo-xray'].filter((id) => document.getElementById(id))),
    [],
    'the document shown after the close carries nothing of the closed session',
  );
});

test('a start that fails after a refresh drew the panel retires the page code it drew', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'model-inspector-failed-start-'));
  const server = http.createServer((_request, response) =>
    response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Invented app</title>'),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext(),
    page = await context.newPage();
  let held, failBindings, drawn, releaseDraw, passed;
  const bindingsHeld = new Promise((resolve) => {
    held = resolve;
  });
  const bindingsGate = new Promise((resolve) => {
    failBindings = resolve;
  });
  const xrayDrawn = new Promise((resolve) => {
    drawn = resolve;
  });
  const drawGate = new Promise((resolve) => {
    releaseDraw = resolve;
  });
  const drawPassed = new Promise((resolve) => {
    passed = resolve;
  });
  ownedFixture(t).add(async () => {
    failBindings();
    releaseDraw();
  });
  ownContextServerRoot(t, context, server, root);
  await page.goto(origin + '/main.aspx?etn=inv_item');
  // The page bindings open a protocol session first. That step waits at a gate and then fails, so the start fails
  // after its page listeners are registered and after a refresh drew the panel and the X-ray.
  context.newCDPSession = async () => {
    held();
    await bindingsGate;
    throw new Error('Invented binding failure');
  };
  // The answer of the X-ray call waits at a second gate, so the start fails between two page calls of one draw. The
  // context read is the first call after a draw.
  const evaluate = page.evaluate.bind(page);
  const called = [];
  page.evaluate = async (fn, argument) => {
    called.push(fn);
    if (fn === inspectModelDrivenContext) passed();
    const answer = await evaluate(fn, argument);
    if (fn === xrayUi) {
      drawn();
      await drawGate;
    }
    return answer;
  };
  const sources = imported();
  const started = startModelDrivenInspector({
    context,
    page,
    overlay: createModelDrivenOverlay({ origin, imported: sources }),
    cfg: { origin, stateDir: root, sourceDir: root, siteName: 'invented', envName: 'loopback' },
    imported: sources,
  });
  const outcome = assert.rejects(started, /Invented binding failure/);
  await bindingsHeld;
  // A console error is a page event that schedules a refresh.
  await evaluate(() => console.error('Invented page problem'));
  await xrayDrawn;
  assert.deepEqual(
    await evaluate(() => ['paqvilo-panel', 'paqvilo-xray'].filter((id) => document.getElementById(id))),
    ['paqvilo-panel', 'paqvilo-xray'],
    'the refresh drew the panel and the X-ray before the start failed',
  );
  failBindings();
  await outcome;
  assert.deepEqual(
    await evaluate(() => ['paqvilo-panel', 'paqvilo-xray'].filter((id) => document.getElementById(id))),
    [],
    'the failed start leaves nothing of its session on the page',
  );
  releaseDraw();
  await drawPassed;
  assert.equal(called.includes(modelDrivenInspectorUi), false, 'the failed start makes no further draw call');
  assert.deepEqual(
    await evaluate(() => ['paqvilo-panel', 'paqvilo-xray'].filter((id) => document.getElementById(id))),
    [],
    'the draw in progress does not restore the panel',
  );
});
