// @test-kind contract+security: agent snapshot pierce reads closed shadow roots and cross-origin frames read-only through the DevTools protocol, and never reports field values, editable text, link queries or the toolkit panel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentBrowserFixture } from './support/agent-fixture.mjs';
import { readDiscovery } from '../lense/commands/agent.mjs';
import { piercedSnapshot } from '../lense/dom-pierce.mjs';

// A closed shadow root, an open one and a field inside each: page code cannot enter the closed one. Every document that
// runs it counts the mutations of its own tree and of each shadow root (window.__mutations), observed before any read.
const SHADOW_SCRIPT = `
  window.__mutations = 0;
  const __observe = (node) =>
    new MutationObserver((records) => { window.__mutations += records.length; })
      .observe(node, { subtree: true, childList: true, attributes: true, characterData: true });
  class ClosedCard extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'closed' });
      root.innerHTML = '<p id="closed-text">Closed shadow content</p><input type="password" value="shadowSecret"><div contenteditable>shadowEditable</div>';
      __observe(root);
    }
  }
  customElements.define('closed-card', ClosedCard);
  class OpenCard extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<p id="open-text">Open shadow content</p>';
      __observe(root);
    }
  }
  customElements.define('open-card', OpenCard);
  __observe(document);
`;
// The frames' places in the top viewport; a frame's heading sits at its frame's top-left corner.
const SAME_SITE_BOX = { x: 20, y: 300 };
const CROSS_SITE_BOX = { x: 400, y: 300 };
const frameStyle = ({ x, y }) => `position:absolute;left:${x}px;top:${y}px;width:300px;height:150px;border:0`;

// Site isolation decides whether a cross-site frame runs out of process; the browser's default differs between builds
// (Playwright Chromium kept the localhost frame in process, Edge did not). Each test forces one process model and
// asserts which path read the frame. The 127.0.0.1 frame on the second port is cross-origin but same-site: it stays in
// the page's process either way.
const PROCESS_MODELS = {
  isolated: { args: ['--site-per-process'], crossSiteOutOfProcess: true },
  shared: { args: ['--disable-site-isolation-trials'], crossSiteOutOfProcess: false },
};

async function pierceScenario(t, { args, crossSiteOutOfProcess }) {
  const { serve, launch } = agentBrowserFixture(t, 'pp-agent-pierce-');
  const frameDocument = `<!doctype html><title>Frame</title><body style="margin:0"><h2 id="foreign" style="margin:0">Foreign frame heading</h2><input value="frameSecret"><a href="next?token=frameLink">Next</a><closed-card></closed-card><script>${SHADOW_SCRIPT}</script>`;
  const foreign = await serve((request, response) =>
    response.writeHead(200, { 'content-type': 'text/html' }).end(frameDocument),
  );
  const foreignPort = new URL(foreign).port;
  const sameSite = `http://127.0.0.1:${foreignPort}/frame`;
  const crossSite = `http://localhost:${foreignPort}/frame`;
  const origin = await serve((request, response) =>
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        `<!doctype html><title>Pierce fixture</title><svg width="1" height="1"><title>Drawing title</title></svg><closed-card></closed-card><open-card></open-card><iframe id="same-site" style="${frameStyle(SAME_SITE_BOX)}" src="${sameSite}"></iframe><iframe id="cross-site" style="${frameStyle(CROSS_SITE_BOX)}" src="${crossSite}"></iframe><div id="paqvilo-panel"><p id="panel-text">Developer panel</p></div><script>${SHADOW_SCRIPT}</script>`,
      ),
  );
  const { context, page, agent } = await launch(origin, { args });
  const discovery = await readDiscovery(agent.discoveryFile);
  const snapshot = async (body) => {
    const response = await fetch(`${agent.endpoint}/v1/pages/1/dom`, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  await page.goto(`${origin}/`, { waitUntil: 'load' });
  const frames = page.frames().filter((frame) => frame !== page.mainFrame());
  assert.equal(frames.length, 2);
  // Preconditions of the forced process model: only an out-of-process frame has a DevTools session of its own.
  const ownSession = async (frame) => {
    try {
      await (await context.newCDPSession(frame)).detach();
      return true;
    } catch (error) {
      assert.match(error.message, /separate CDP session/);
      return false;
    }
  };
  assert.equal(await ownSession(frames.find((frame) => frame.url() === sameSite)), false);
  assert.equal(await ownSession(frames.find((frame) => frame.url() === crossSite)), crossSiteOutOfProcess);

  // The page snapshot cannot enter a closed shadow root or a cross-origin frame.
  const plain = await snapshot({ selector: '#closed-text, #foreign' });
  assert.equal(plain.status, 200);
  assert.equal(plain.body.total, 0);

  const closed = await snapshot({ selector: '#closed-text', pierce: true });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  const top = closed.body.elements.filter((element) => element.scope.frame === null);
  assert.equal(top.length, 1);
  assert.equal(top[0].text, 'Closed shadow content');
  assert.equal(top[0].scope.shadowRoot, 'closed');
  assert.ok(top[0].rect.width > 0 && top[0].visible);
  // The same closed card inside each frame is read as well.
  assert.equal(closed.body.total, 3);

  const open = await snapshot({ selector: '#open-text', pierce: true });
  assert.deepEqual(
    open.body.elements.map((element) => [element.text, element.scope.shadowRoot]),
    [['Open shadow content', 'open']],
  );

  // Both cross-origin frames are read, each through the path its process model gives it.
  const heading = await snapshot({ selector: '#foreign', pierce: true, styles: ['display'] });
  assert.equal(heading.status, 200);
  assert.deepEqual(
    heading.body.elements.map((element) => [
      element.text,
      element.scope.frame.origin,
      element.scope.frame.crossOrigin,
      element.scope.frame.outOfProcess,
    ]),
    [
      ['Foreign frame heading', `http://127.0.0.1:${foreignPort}`, true, false],
      ['Foreign frame heading', `http://localhost:${foreignPort}`, true, crossSiteOutOfProcess],
    ],
  );
  assert.equal(heading.body.elements[1].style.display, 'block');
  // Frame content is placed in the top viewport, through the owner's box when the frame has its own viewport.
  assert.deepEqual(
    heading.body.elements.map(({ rect, visible }) => [rect.x, rect.y, visible]),
    [
      [SAME_SITE_BOX.x, SAME_SITE_BOX.y, true],
      [CROSS_SITE_BOX.x, CROSS_SITE_BOX.y, true],
    ],
  );
  // The title is the document's HTML title, as document.title reads it, not the drawing's.
  assert.equal(heading.body.title, await page.title());
  assert.equal(heading.body.elements[1].scope.frame.url, crossSite);
  assert.deepEqual(heading.body.boundaries, {
    openShadowRoots: 1,
    closedShadowRoots: 3,
    frames: 2,
    crossOriginFrames: 2,
    outOfProcessFrames: crossSiteOutOfProcess ? 1 : 0,
    unreadFrames: 0,
    detachedFrames: 0,
  });

  // Every element: no field value, editable text, link query or panel content, and a frame link resolves to its frame.
  const all = await snapshot({ selector: '*', pierce: true, limit: 200 });
  assert.equal(all.status, 200);
  const text = JSON.stringify(all.body);
  for (const secret of ['shadowSecret', 'shadowEditable', 'frameSecret', 'frameLink', 'Developer panel'])
    assert.equal(text.includes(secret), false, secret);
  const links = all.body.elements.filter((element) => element.tag === 'a').map((element) => element.attributes.href);
  assert.deepEqual(links, [
    `http://127.0.0.1:${foreignPort}/next?token=%5Bredacted%5D`,
    `http://localhost:${foreignPort}/next?token=%5Bredacted%5D`,
  ]);
  assert.equal(
    all.body.elements.some((element) => element.attributes.id === 'panel-text'),
    false,
  );

  // Reading changed nothing: no document, frame document or shadow root saw a mutation.
  assert.deepEqual(
    await Promise.all(page.frames().map((frame) => frame.evaluate(() => window.__mutations))),
    [0, 0, 0],
  );

  const invalid = await snapshot({ selector: 'div[[[', pierce: true });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'invalid_selector');
  const wrongType = await snapshot({ pierce: 'yes' });
  assert.equal(wrongType.status, 400);
  assert.equal(wrongType.body.error.code, 'invalid_argument');
}

test('real browser, site isolation forced: pierce reads the out-of-process frame through its own session', (t) =>
  pierceScenario(t, PROCESS_MODELS.isolated));

test('real browser, site isolation off: pierce reads both cross-origin frames in the page process', (t) =>
  pierceScenario(t, PROCESS_MODELS.shared));

// @test-kind contract: a frame that goes away while the snapshot reads it is skipped and counted, never failing the read; the title of a page without an HTML title is empty, as document.title is, even with an SVG title
test('real browser: a frame removed during the pierce read is counted, and the rest is read', async (t) => {
  const { serve, launch } = agentBrowserFixture(t, 'pp-agent-pierce-detach-');
  const foreign = await serve((request, response) =>
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<!doctype html><title>Frame</title><h2 id="foreign">Foreign frame heading</h2>'),
  );
  const port = new URL(foreign).port;
  const origin = await serve((request, response) =>
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        `<!doctype html><svg width="1" height="1"><title>Drawing title</title></svg><iframe id="gone" src="http://localhost:${port}/gone"></iframe><iframe id="kept" src="http://localhost:${port}/kept"></iframe>`,
      ),
  );
  const { context, page } = await launch(origin, PROCESS_MODELS.isolated);
  await page.goto(`${origin}/`, { waitUntil: 'load' });
  const gone = page.frames().find((frame) => frame.url().endsWith('/gone'));
  // The gate: when the snapshot asks the removed frame's session for its frame tree, the page first removes that frame
  // and the browser reports it detached; only then does the request go to the browser.
  let removed = false;
  const gated = {
    async newCDPSession(target) {
      const session = await context.newCDPSession(target);
      if (target !== gone) return session;
      return {
        detach: () => session.detach(),
        async send(method, params) {
          if (method === 'Page.getFrameTree') {
            const detached = new Promise((resolve) => page.on('framedetached', (frame) => frame === gone && resolve()));
            await page.evaluate(() => document.getElementById('gone').remove());
            await detached;
            removed = true;
          }
          return session.send(method, params);
        },
      };
    },
  };
  const result = await piercedSnapshot({
    context: gated,
    page,
    origin,
    selector: '#foreign',
    limit: 10,
    textLimit: 100,
    styles: [],
  });
  assert.equal(removed, true);
  assert.deepEqual(
    result.elements.map((element) => [element.text, element.scope.frame.url, element.scope.frame.outOfProcess]),
    [['Foreign frame heading', `http://localhost:${port}/kept`, true]],
  );
  assert.equal(result.boundaries.detachedFrames, 1);
  assert.equal(result.boundaries.frames, 1);
  assert.equal(result.title, '');
  assert.equal(await page.title(), '');
});
