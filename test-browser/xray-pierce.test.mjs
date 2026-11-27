// @test-kind contract+security: Inspect reads the element under the pointer inside a closed shadow root or a cross-origin frame read-only through the DevTools protocol (lense/dom-pierce.mjs piercedElementAt via the panel's pierce action), reports where it stands and its source, and never shows field values or link queries
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { listenOwnedServer } from './helpers/owned-server.mjs';
import { chromium } from 'playwright-core';
import { OverlaySession } from '../lense/session.mjs';
import { attachSession } from '../lense/browser.mjs';
import { enablePanel } from '../lense/panel.mjs';
import { SITE } from '../test/fixture.mjs';
import { inspectionFixture } from '../test/source-inspection-fixture.mjs';

// Every document counts the mutations of its own tree and of each shadow root it creates, observed before any pick.
const COMPONENT_SCRIPT = `
  window.__mutations = 0;
  const __observe = (node) =>
    new MutationObserver((records) => { window.__mutations += records.length; })
      .observe(node, { subtree: true, childList: true, attributes: true, characterData: true });
  customElements.define('closed-card', class extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'closed' });
      root.innerHTML = '<p id="closed-text" style="margin:0;height:40px">Closed shadow content</p><input id="closed-field" type="password" value="shadowSecret" style="display:block;width:200px;height:30px">';
      window.__closedRoot = (callback) => callback(root);
      __observe(root);
    }
  });
`;
// A cross-origin frame's document; it holds another page of the portal (`portal`'s /nested/) in a frame of its own.
const frameDocument = (portal) =>
  `<!doctype html><title>Frame</title><body style="margin:0"><h2 id="foreign" style="margin:0;height:60px">Foreign frame heading</h2><a id="foreign-link" href="next?token=frameLink" style="display:block;height:30px">Next</a><closed-card style="display:block"></closed-card><iframe id="nested" src="${portal}/nested/" style="display:block;width:280px;height:60px;border:0"></iframe><input value="frameSecret"><script>${COMPONENT_SCRIPT}__observe(document);</script>`;
// The exported copy of the portal page in that nested frame: a closed declarative root, its paragraph on line 3.
const NESTED_COPY = [
  '<div id="nested-host">',
  '  <template shadowrootmode="closed">',
  '    <p id="nested-text" style="margin:0;height:40px">Written by the nested copy</p>',
  '  </template>',
  '</div>',
].join('\n');
const nestedPage = `<!doctype html><html><head><title>Nested</title></head><body style="margin:0">${NESTED_COPY}</body></html>`;
// An exported web template that writes a closed declarative shadow root; the portal serves it as written. Its paragraph
// is on line 4.
const SEALED_TEMPLATE = [
  '<section id="sealed-section" style="position:absolute;left:700px;top:700px;width:300px">',
  '  <sealed-card id="sealed">',
  '    <template shadowrootmode="closed">',
  '      <p id="sealed-text" style="margin:0;height:40px">Written by the template</p>',
  '    </template>',
  '  </sealed-card>',
  '</section>',
].join('\n');
// The exported copy of another portal page, shown in a same-origin iframe of the page: it writes a closed declarative
// shadow root too, and the frame's document runs a provenance registry of its own. Its paragraph is on line 3.
const FRAMED_COPY = [
  '<div id="framed-host">',
  '  <template shadowrootmode="closed">',
  '    <p id="framed-text" style="margin:0;height:40px">Written by the page copy</p>',
  '  </template>',
  '</div>',
].join('\n');
const PROCESS_MODELS = {
  isolated: { args: ['--site-per-process'], crossSiteOutOfProcess: true },
  shared: { args: ['--disable-site-isolation-trials'], crossSiteOutOfProcess: false },
};

async function inspectScenario(t, { args, crossSiteOutOfProcess }) {
  const fx = inspectionFixture();
  fs.writeFileSync(
    path.join(fx.portal, 'web-templates/Sealed.webtemplate.yml'),
    'adx_webtemplateid: sealed\nadx_name: Sealed',
  );
  fs.writeFileSync(path.join(fx.portal, 'web-templates/Sealed.webtemplate.source.html'), SEALED_TEMPLATE);
  fs.writeFileSync(path.join(fx.portal, 'web-pages/other/Other.webpage.copy.html'), FRAMED_COPY);
  fs.mkdirSync(path.join(fx.portal, 'web-pages/nested'), { recursive: true });
  fs.writeFileSync(
    path.join(fx.portal, 'web-pages/nested/Nested.webpage.yml'),
    'adx_webpageid: nested\nadx_name: Nested\nadx_partialurl: nested\nadx_parentpageid: home',
  );
  fs.writeFileSync(path.join(fx.portal, 'web-pages/nested/Nested.webpage.copy.html'), NESTED_COPY);
  fs.writeFileSync(
    path.join(fx.portal, 'web-templates/Main.webtemplate.source.html'),
    '{% include "Partial" %}{% include "Sealed" %}',
  );
  const frames = http.createServer((request, response) =>
    response.writeHead(200, { 'content-type': 'text/html' }).end(frameDocument('')),
  );
  const framePort = new URL(await listenOwnedServer(t, frames)).port;
  const sameSite = `http://127.0.0.1:${framePort}/frame`;
  const crossSite = `http://localhost:${framePort}/frame`;
  const frameStyle = (left) => `position:absolute;left:${left}px;top:420px;width:300px;height:220px;border:0`;
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
    if (pathname === '/favicon.ico') return response.writeHead(204).end();
    if (pathname === '/nested/') return response.writeHead(200, { 'content-type': 'text/html' }).end(nestedPage);
    if (pathname === '/other/')
      return response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<!doctype html><html><head><title>Other</title></head><body style="margin:0">${FRAMED_COPY}</body></html>`,
        );
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        `<!doctype html><html><head><title>Pierce fixture</title></head><body style="margin:0"><h1>Widgets</h1><p id="plain" style="position:absolute;left:700px;top:300px;margin:0">Plain paragraph</p><div id="EntityFormControl_widgetedit" style="position:absolute;left:40px;top:200px;width:400px"><div id="EntityFormControl_widgetedit_EntityFormView"><span data-form-layout='{"Id":"widget-edit","EntityName":"fx_widget"}'></span><table class="section"><tbody><tr><td class="cell"><div class="table-info"><label for="fx_title">Title</label></div><div class="control" data-logical-name="fx_title"><closed-card id="card" style="display:block"></closed-card></div></td></tr></tbody></table></div></div><iframe id="same-site" style="${frameStyle(40)}" src="${sameSite}"></iframe><iframe id="cross-site" style="${frameStyle(500)}" src="${crossSite}"></iframe>${SEALED_TEMPLATE}<iframe id="portal-frame" src="/other/" style="position:absolute;left:40px;top:700px;width:300px;height:100px;border:0"></iframe><script>${COMPONENT_SCRIPT}</script></body></html>`,
      );
  });
  let browser, panel, detach;
  // The panel, the interception and the browser close in this order; the fixture files go last.
  const owner = ownedFixture(t);
  for (const close of [() => panel?.dispose(), () => detach?.(), () => browser?.close()]) owner.add(close);
  owner.remove(() => fx.cleanup());
  const origin = await listenOwnedServer(t, server);
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  browser = await chromium.launch({
    channel: channel === 'chromium' ? undefined : channel,
    headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', ...args],
  });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
  // The frames are answered by the browser context: a Lense-answered portal page is a public document, so the browser's
  // local network access checks would refuse a loopback frame address. Which process a frame runs in depends on its
  // site, not on how it was answered.
  await context.route(
    (url) => url.port === framePort && url.pathname === '/frame',
    (route) => route.fulfill({ contentType: 'text/html', body: frameDocument(origin) }),
  );
  const page = await context.newPage();
  const session = new OverlaySession({
    origin,
    siteName: 'Pierce fixture',
    envName: 'loopback',
    site: structuredClone(SITE),
    sourceDir: fx.portal,
    stateDir: fx.work,
    mirageConfig: { project: fx.project },
    sourceMaps: false,
    browser: {},
  });
  detach = await attachSession(context, session);
  panel = enablePanel(context, session, { open: async () => null });
  await page.goto(origin, { waitUntil: 'load' });
  // Precondition of the forced process model: only an out-of-process frame has a DevTools session of its own.
  const crossFrame = page.frames().find((frame) => frame.url() === crossSite);
  let ownSession = true;
  try {
    await (await context.newCDPSession(crossFrame)).detach();
  } catch {
    ownSession = false;
  }
  assert.equal(ownSession, crossSiteOutOfProcess);
  const scope = page.locator('#paqvilo-panel');
  await scope.locator('.pill').click();
  await scope.locator('[data-act="tab"][data-v="runtime"]').click();
  const card = scope.locator('[data-selected-identity]');
  const generation = () =>
    page.evaluate(() => document.getElementById('paqvilo-xray').__px.selectionState().selectionGeneration);
  // Selects the element at viewport point (x, y) as a person does: the pointer leaves the panel over the page, then
  // reaches the point (the shield lets the pointer through only while it is over Lense's own UI). With `inspect`,
  // through the panel's Inspect button; otherwise X-ray is on. The details card of the previous pick opens beside it and
  // can cover the next point, so that selection is cleared first.
  const pick = async (x, y, { inspect = true } = {}) => {
    await page.evaluate(() => document.getElementById('paqvilo-xray').__px.clearSelection('user-clear'));
    const before = await generation();
    if (inspect) await scope.locator('[data-act="inspect-pick"]').click();
    await page.mouse.move(600, 120);
    await page.mouse.move(x, y, { steps: 4 });
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForFunction((previous) => {
      const state = document.getElementById('paqvilo-xray').__px.selectionState();
      return state.selectionGeneration > previous && state.identity;
    }, before);
    return generation();
  };
  // Picks with the panel's Inspect button and waits for the pierced read in the panel's selection summary.
  const pickAt = async (x, y) => {
    const section = card.locator(`.section.pierced[data-generation="${await pick(x, y)}"]`);
    await section.waitFor();
    return section;
  };

  // Inside the closed shadow root: the page sees only the host; Inspect reads the paragraph under the pointer.
  const host = await page.locator('#card').boundingBox();
  const shadow = await pickAt(host.x + 20, host.y + 10);
  assert.equal(await shadow.getAttribute('data-pierced'), 'closed-shadow-root');
  assert.match(await shadow.locator('h3').innerText(), /Inside a closed shadow root/);
  assert.equal(await shadow.locator('.binding strong').innerText(), '<p>');
  assert.equal(await shadow.locator('.binding .muted').innerText(), 'Closed shadow content');
  assert.match(await shadow.locator('.note').innerText(), /Contained in its shadow host/);
  // Its source is the host's: the summary names the host's identification above the element read below it.
  const selection = await page.evaluate(() => document.getElementById('paqvilo-xray').__px.selectionState());
  assert.ok(selection.identity.evidence.owner.component);
  assert.equal(await card.locator('.sel-name').innerText(), selection.identity.title);
  assert.match(selection.identity.title, /closed-card/);
  // A closed declarative shadow root the export writes: its element maps to that template's line, as other elements do.
  const sealedHost = await page.locator('#sealed').boundingBox();
  const sealed = await pickAt(sealedHost.x + 20, sealedHost.y + 10);
  assert.equal(await sealed.getAttribute('data-pierced'), 'closed-shadow-root');
  assert.equal(await sealed.locator('.binding .muted').innerText(), 'Written by the template');
  assert.match(await sealed.locator('.note').innerText(), /^Written by the exported source/);
  assert.deepEqual(await sealed.locator('[data-pierced-source]').allInnerTexts(), [
    'web-templates/Sealed.webtemplate.source.html:4',
  ]);
  // The same in a same-origin portal frame: its closed root goes to the frame's own registry, and its element maps to
  // the frame page's copy.
  const framedHost = await page.frameLocator('#portal-frame').locator('#framed-host').boundingBox();
  const framed = await pickAt(framedHost.x + 20, framedHost.y + 10);
  assert.equal(await framed.getAttribute('data-pierced'), 'closed-shadow-root');
  assert.equal(await framed.locator('.binding .muted').innerText(), 'Written by the page copy');
  assert.deepEqual(await framed.locator('[data-pierced-source]').allInnerTexts(), [
    'web-pages/other/Other.webpage.copy.html:3',
  ]);
  // The response marks nothing inside the closed root (only its component could read a mark): the binding names the
  // element's place under its host.
  const cdp = await context.newCDPSession(page);
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const attributesOf = (node, id) => {
    if (node.attributes?.includes(id)) return node.attributes;
    for (const next of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
      const found = attributesOf(next, id);
      if (found) return found;
    }
    return null;
  };
  assert.deepEqual(attributesOf(root, 'sealed-text'), ['id', 'sealed-text', 'style', 'margin:0;height:40px']);
  await cdp.detach();
  // A field inside the closed root is reported without its value.
  const field = await pickAt(host.x + 20, host.y + 55);
  assert.equal(await field.locator('.binding strong').innerText(), '<input>');
  assert.doesNotMatch(await card.innerText(), /shadowSecret/);

  // Inside each cross-origin frame: the in-process one through the page's pierced document, the cross-site one through
  // its own session when it runs out of process.
  for (const [frameUrl, frameOrigin] of [
    [sameSite, `http://127.0.0.1:${framePort}`],
    [crossSite, `http://localhost:${framePort}`],
  ]) {
    const owner = await page.locator(`iframe[src="${frameUrl}"]`).boundingBox();
    const heading = await pickAt(owner.x + 30, owner.y + 20);
    assert.equal(await heading.getAttribute('data-pierced'), 'cross-origin-frame');
    assert.equal(
      await heading.locator('h3').innerText(),
      `Inside a cross-origin frame · ${frameOrigin} read through the DevTools protocol`,
    );
    assert.equal(await heading.locator('.binding strong').innerText(), '<h2>');
    assert.equal(await heading.locator('.binding .muted').innerText(), 'Foreign frame heading');
    assert.match(await heading.locator('.note').innerText(), /Not portal source/);
    const link = await pickAt(owner.x + 30, owner.y + 75);
    assert.equal(await link.locator('.binding strong').innerText(), '<a>');
    const linkCard = await card.innerText();
    assert.ok(linkCard.includes(`${frameOrigin}/next?token=%5Bredacted%5D`), linkCard);
    assert.doesNotMatch(linkCard, /frameLink|frameSecret/);
    // A closed root inside a cross-origin frame: there is no exported source for it either.
    const inFrameRoot = await pickAt(owner.x + 30, owner.y + 105);
    assert.equal(await inFrameRoot.getAttribute('data-pierced'), 'cross-origin-frame');
    assert.equal(await inFrameRoot.locator('.binding .muted').innerText(), 'Closed shadow content');
    assert.match(await inFrameRoot.locator('.note').innerText(), /^Not portal source/);
    assert.equal(await inFrameRoot.locator('[data-pierced-source]').count(), 0);
    // A portal page nested in that frame, in the tab's process or out of it (under a cross-site frame with site
    // isolation): Lense serves and proves it, and its closed root maps to its copy through its own registry.
    const nested = await pickAt(owner.x + 20, owner.y + 180);
    assert.equal(await nested.locator('.binding .muted').innerText(), 'Written by the nested copy');
    assert.equal(await nested.getAttribute('data-pierced'), 'closed-shadow-root');
    assert.deepEqual(await nested.locator('[data-pierced-source]').allInnerTexts(), [
      'web-pages/nested/Nested.webpage.copy.html:3',
    ]);
    // Which process the nested portal frame runs in: its own (a session of its own) only under the cross-site frame
    // with site isolation.
    const nestedFrame = page.frames().find((item) => item.parentFrame()?.url() === frameUrl);
    let nestedSession = true;
    try {
      await (await context.newCDPSession(nestedFrame)).detach();
    } catch {
      nestedSession = false;
    }
    assert.equal(nestedSession, frameUrl === crossSite && crossSiteOutOfProcess);
  }

  // A pick outside any sealed part reads nothing below the selection.
  const plain = await page.locator('#plain').boundingBox();
  await pick(plain.x + 5, plain.y + 5);
  await page.waitForFunction(() => document.getElementById('paqvilo-xray').__px.piercedState()?.reading === false);
  assert.equal(await page.evaluate(() => document.getElementById('paqvilo-xray').__px.piercedState().found), null);
  assert.equal(await card.locator('.section.pierced').count(), 0);

  // X-ray's own card shows the same read when X-ray is on.
  await page.evaluate(() => document.getElementById('paqvilo-xray').__px.toggle(true));
  const inCard = page.locator(
    `#paqvilo-xray .card .section.pierced[data-generation="${await pick(host.x + 20, host.y + 10, { inspect: false })}"]`,
  );
  await inCard.waitFor();
  assert.equal(await inCard.locator('.binding strong').innerText(), '<p>');
  await page.evaluate(() => document.getElementById('paqvilo-xray').__px.toggle(false));

  // Reading changed nothing the page owns behind the boundaries: the closed root and both frame documents.
  const frameMutations = await Promise.all(
    page
      .frames()
      .filter((frame) => frame !== page.mainFrame() && !/\/(?:other|nested)\/$/.test(frame.url()))
      .map((frame) => frame.evaluate(() => window.__mutations)),
  );
  assert.deepEqual(frameMutations, [0, 0]);
  assert.equal(await page.evaluate(() => window.__mutations), 0, 'the closed root saw no mutation');
}

test('real browser, site isolation forced: Inspect reads closed shadow roots and cross-origin frames', (t) =>
  inspectScenario(t, PROCESS_MODELS.isolated));

test('real browser, site isolation off: Inspect reads closed shadow roots and in-process cross-origin frames', (t) =>
  inspectScenario(t, PROCESS_MODELS.shared));
