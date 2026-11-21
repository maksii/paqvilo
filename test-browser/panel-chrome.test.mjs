// @test-kind contract: the Lense panel chrome (portal and model-driven) keeps its own look under hostile page CSS, keeps the element under the pointer across redraws, does not move rows on hover, keeps its header controls on one row and labels rows, chips, filters, pill and footer in words the user can act on.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { once } from 'node:events';
import { panelUi } from '../lense/panel-ui.mjs';
import { modelDrivenPanelData } from '../lense/model-driven-panel.mjs';

// Rules a portal stylesheet may have: inherited text properties on body, a universal !important rule, and rules that
// match the panel's host element by tag and by id.
const HOSTILE =
  'body{color:red;font:30px serif;letter-spacing:5px;text-transform:uppercase;line-height:3;word-spacing:9px}' +
  '*{color:red!important}' +
  'div{color:red!important;font-family:serif!important;direction:rtl!important;cursor:wait!important;visibility:visible!important;text-indent:20px!important;white-space:pre!important;font-style:italic!important}' +
  '#paqvilo-panel{font-size:30px!important;text-align:right!important}' +
  'a{color:red}.btn-primary{background:red;color:yellow}.text-muted{color:orange}';

// Page CSS that matches the panel's host element itself: a filter, a fade, a rotation, a frame and padding.
const HOST_CSS =
  'body>div{filter:blur(3px)!important;opacity:.3!important;rotate:10deg!important;transform:scale(.5)!important;border:6px solid red!important;margin:40px!important}div{padding:30px!important}';
const corner = (style) => `<a href="#" style="position:fixed;${style};width:240px;height:40px">Invented link</a>`;
const PAGES = {
  '/host-css': `<!doctype html><title>Invented host CSS</title><style>${HOST_CSS}</style><h1>Invented portal</h1>`,
  // A link in every corner, as a portal's logo, sign-in and footer cards: the top edge is free between them.
  '/corners': `<!doctype html><title>Invented corners</title>${[
    'left:0;top:0',
    'right:0;top:0',
    'left:0;bottom:0;width:100%',
  ]
    .map(corner)
    .join('')}`,
};
let browser, origin, server;
before(async () => {
  server = http.createServer((request, response) =>
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        PAGES[request.url] ??
          `<!doctype html><title>Invented chrome fixture</title><style>${request.url === '/hostile' ? HOSTILE : ''}</style><h1>Invented portal</h1><a href="#">link</a><button class="btn btn-primary">Primary</button>`,
      ),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(browserLaunchOptions());
});
after(async () => {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const panelState = (modelDriven, extra = {}) => {
  const data = modelDrivenPanelData(
    { origin, token: `invented-chrome-${modelDriven}`, resources: [], diagnostics: [], revision: 1, resourceCount: 0 },
    {
      cfg: { siteName: modelDriven ? 'invented.project.yml' : 'invented-portal', envName: 'Invented env' },
      ui: { open: true },
    },
  );
  return {
    ...data,
    modelDriven,
    ...(modelDriven ? {} : { transport: undefined, capabilities: { actions: false, targets: false } }),
    setupUrl: `${origin}/setup`,
    items: [
      { group: 'css', kind: 'web-file', rel: 'web-files/first.css', url: '/first.css', canDiff: true, canPause: true },
      {
        group: 'css',
        kind: 'web-file',
        rel: 'web-files/second.css',
        url: '/second.css',
        canDiff: true,
        canPause: true,
      },
    ],
    ...extra,
  };
};

const open = async (t, path, state, viewport = { width: 1280, height: 960 }, beforePanel = null) => {
  const context = await browser.newContext({ viewport });
  ownedFixture(t).add(() => context.close());
  const page = await context.newPage();
  await page.goto(origin + path);
  await page.evaluate(() => {
    window.__paqviloModelPanelApi = async () => ({ ok: true });
  });
  if (beforePanel) await page.evaluate(beforePanel);
  await page.evaluate(panelUi, state);
  return page;
};

const PROPERTIES = [
  'color',
  'font-family',
  'font-size',
  'font-style',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-transform',
  'text-indent',
  'text-align',
  'direction',
  'visibility',
  'cursor',
  'white-space',
];
const panelStyles = (page) =>
  page.evaluate((properties) => {
    const root = document.getElementById('paqvilo-panel').shadowRoot;
    return [...root.querySelectorAll('.wrap *')]
      .filter((node) => node.getClientRects().length)
      .map((node) => {
        const style = getComputedStyle(node);
        return `${node.tagName}.${node.className.baseVal ?? node.className}: ${properties.map((name) => style.getPropertyValue(name)).join(' | ')}`;
      });
  }, PROPERTIES);

for (const modelDriven of [false, true]) {
  const kind = modelDriven ? 'model-driven' : 'Power Pages';

  test(`${kind} panel text is not restyled by the page's CSS`, async (t) => {
    const plain = await panelStyles(await open(t, '/plain', panelState(modelDriven)));
    const hostile = await panelStyles(await open(t, '/hostile', panelState(modelDriven)));
    assert.ok(plain.length > 40, 'the open panel is measured');
    assert.deepEqual(hostile, plain);
  });

  test(`${kind} panel keeps the hovered element across a redraw that changes another row`, async (t) => {
    const state = panelState(modelDriven);
    const page = await open(t, '/plain', state);
    const row = page.locator('#paqvilo-panel .row[data-rel="web-files/first.css"]');
    const button = row.locator('[data-act=copy]');
    const before = await row.evaluate((node) => {
      const main = node.querySelector('.main').getBoundingClientRect();
      return { height: node.getBoundingClientRect().height, main: main.width };
    });
    // Row actions are visible before the pointer reaches the row, the same on every tab.
    assert.equal(await button.isVisible(), true, 'row actions do not wait for hover');
    await row.locator('.main').hover();
    await button.hover();
    assert.deepEqual(
      await row.evaluate((node) => {
        const main = node.querySelector('.main').getBoundingClientRect();
        return { height: node.getBoundingClientRect().height, main: main.width };
      }),
      before,
      'hovering a row does not resize it or its text',
    );
    await button.evaluate((node) => {
      window.hoveredButton = node;
    });
    state.items[1].count = 3;
    await page.evaluate(panelUi, state);
    assert.match(await page.locator('#paqvilo-panel .row[data-rel="web-files/second.css"]').innerText(), /3 requests/);
    assert.equal(await button.evaluate((node) => node === window.hoveredButton && node.matches(':hover')), true);
  });

  test(`${kind} header keeps its controls on one row and the target on a second line`, async (t) => {
    const page = await open(t, '/plain', panelState(modelDriven));
    const head = page.locator('#paqvilo-panel .head');
    assert.equal(await head.locator('[data-act=reload]').count(), 0, 'F5 reloads the page; the header has no Reload');
    for (const size of ['default', 'large']) {
      if (size === 'large') await head.locator('[data-act=size]').click();
      const layout = await head.evaluate((node) => {
        const top = (selector) => Math.round(node.querySelector(selector).getBoundingClientRect().top);
        const controls = [...node.querySelectorAll('.ctl > *')].map((item) => item.getBoundingClientRect());
        return {
          rows: new Set(controls.map((r) => Math.round(r.top + r.height / 2))).size,
          brandAboveTarget: top('.brand') < top('.tag.env'),
          siteBesideEnv: top('.tag:not(.env)') === top('.tag.env'),
        };
      });
      assert.deepEqual(layout, { rows: 1, brandAboveTarget: true, siteBesideEnv: true }, size);
    }
    const local = head.locator('[data-act=mode][data-v=local]');
    const online = head.locator('[data-act=mode][data-v=online]');
    assert.equal(await local.getAttribute('aria-pressed'), 'true');
    assert.equal(await online.getAttribute('aria-pressed'), 'false');
    const [localTitle, onlineTitle] = [await local.getAttribute('title'), await online.getAttribute('title')];
    assert.notEqual(localTitle, onlineTitle);
    // Each says what it shows; only Online adds which tabs switch. The environment's name (here a sentence-breaking
    // "Invented env", in practice often "local") is left to the header.
    assert.match(localTitle, /local files applied|local Solution files/);
    assert.match(onlineTitle, /without your local files\. All tabs of this (?:site|app) switch/);
    for (const title of [localTitle, onlineTitle]) {
      assert.match(title, /\(Alt\+Shift\+O\)$/);
      assert.doesNotMatch(title, /Invented env|every tab of/);
      assert.ok(title.length <= 110, title);
    }
    assert.equal(await head.locator('.seg').getAttribute('title'), null, 'each button explains itself');
  });

  test(`${kind} tab strip and pill show the override count only when there are overrides`, async (t) => {
    const page = await open(t, '/plain', panelState(modelDriven, { items: [] }));
    const overridesTab = page.locator('#paqvilo-panel .tab[data-v=overrides]');
    assert.equal(await overridesTab.locator('.n').count(), 0, 'no "0" badge');
    assert.equal(await page.locator('#paqvilo-panel .pill .n').count(), 0);
    await page.evaluate(panelUi, panelState(modelDriven));
    assert.equal(await overridesTab.locator('.n').textContent(), '2');
    assert.equal(await page.locator('#paqvilo-panel .pill .n.ok').textContent(), '2');
    // No other tab carries a zero count either.
    assert.deepEqual(
      await page.locator('#paqvilo-panel .tab .n').evaluateAll((nodes) => nodes.map((node) => node.textContent)),
      ['2'],
    );
  });

  test(`${kind} rows, chips and filters name what they mean without the environment's name`, async (t) => {
    const state = panelState(modelDriven);
    state.items[0] = { ...state.items[0], differs: true, edited: true, title: 'Invented form', count: 2 };
    state.items[1] = { ...state.items[1], differs: false };
    const page = await open(t, '/plain', state);
    const scope = page.locator('#paqvilo-panel');
    const first = scope.locator('.row[data-rel="web-files/first.css"]');
    assert.equal(
      await first.locator('.main .name').innerText(),
      'Invented form\nedited\ndiffers from deployed\n2 requests',
    );
    assert.match(await scope.locator('.row[data-rel="web-files/second.css"] .name').innerText(), /same as deployed/);
    assert.doesNotMatch(await scope.locator('.body').innerText(), /Invented env|≠|×/);
    // One title pattern for the row and its open button, with the row's name; the diff button is an icon with a title.
    assert.equal(await first.locator('.main').getAttribute('title'), 'Open Invented form in the editor');
    assert.equal(
      await first.locator('[data-act=diff]').getAttribute('title'),
      'Compare Invented form with the deployed version',
    );
    assert.equal(await first.locator('[data-act=diff] svg rect').count(), 2, 'side-by-side comparison icon');
    const filters = scope.locator('.filters [data-act=filter]');
    assert.deepEqual(
      await filters.evaluateAll((nodes) => nodes.map((node) => node.textContent.replace(/\s+/g, ' ').trim())),
      ['All 2', 'Edited 1', 'Differs from deployed 1'],
    );
    for (const title of await filters.evaluateAll((nodes) => nodes.map((node) => node.title)))
      assert.ok(title.length > 20, title);
    assert.equal(await filters.first().getAttribute('aria-pressed'), 'true');
    assert.equal(await scope.locator('.filters .lbl2').innerText(), 'Local files');
    assert.deepEqual(await scope.locator('[data-act=scope]').allInnerTexts(), ['all', 'changed vs Git']);
    // The pill names the site; the environment is in its tooltip.
    const label = scope.locator('.pill .lbl');
    assert.equal(await label.innerText(), modelDriven ? 'invented.project.yml' : 'invented-portal');
    assert.match(await label.getAttribute('title'), /@ Invented env$/);
    // The X-ray and setup buttons are drawn icons, each with a tooltip that says what it does.
    for (const selector of ['[data-act=xray]', 'a[aria-label="Project setup"]']) {
      const control = scope.locator('.head ' + selector);
      assert.equal(await control.locator('svg').count(), 1, selector);
      assert.equal((await control.innerText()).trim(), '', selector);
      assert.ok((await control.getAttribute('title')).length > 20, selector);
    }
    // The toast after opening a file uses the row's name, not its file name.
    await page.route('**/__paqvilo/api/open', (route) => route.fulfill({ json: { ok: true } }));
    await first.locator('.main').click();
    assert.equal(await scope.locator('.toast.show').innerText(), 'Opened Invented form in the editor');
  });

  test(`${kind} Overrides without local files shows only the page and the empty state`, async (t) => {
    const page = await open(t, '/plain', panelState(modelDriven, { items: [] }));
    const scope = page.locator('#paqvilo-panel');
    await scope.locator('.empty').waitFor();
    assert.equal(await scope.locator('.filters').count(), 0, 'no zero-count filters or scope switch');
    assert.doesNotMatch(await scope.locator('.body').innerText(), /Invented env/);
    if (modelDriven) assert.doesNotMatch(await scope.locator('.card .path').innerText(), /main\.aspx/);
    // "changed vs Git" can hide every file: its switch stays so it can be turned off.
    await page.evaluate(panelUi, panelState(modelDriven, { items: [], scope: 'changed' }));
    assert.equal(await scope.locator('[data-act=scope][data-v=all]').count(), 1);
  });

  test(`${kind} footer statistics fit the default panel width`, async (t) => {
    const page = await open(t, '/plain', panelState(modelDriven, { stats: { webFiles: 12, blocks: 3, patches: 1 } }), {
      width: 1280,
      height: 960,
    });
    const stats = page.locator('#paqvilo-panel .foot .stats');
    assert.equal(await stats.innerText(), modelDriven ? '12 web resources' : '12 files · 3 scripts · 1 patch');
    assert.equal(await stats.evaluate((node) => node.scrollWidth <= node.clientWidth), true, 'not clipped');
  });
}

test('the Issues baseline note explains itself and copies the Git message; the header says it once', async (t) => {
  const detail = 'Cannot read baseline HEAD: Command failed: git rev-parse --verify HEAD^{commit}';
  const page = await open(
    t,
    '/plain',
    panelState(false, {
      ui: { open: true, tab: 'issues' },
      git: { baseline: { available: false, requested: 'HEAD' } },
      capabilities: { actions: false, targets: false, git: true },
      notes: [
        { kind: 'baseline', reason: 'Your sources are not in a Git repository, so there is no baseline.', detail },
      ],
    }),
  );
  const scope = page.locator('#paqvilo-panel');
  assert.equal(await scope.locator('.gitline').innerText(), 'No Git baseline');
  const group = scope.locator('.group', { hasText: 'Comparison unavailable' });
  assert.match(await group.innerText(), /Your sources are not in a Git repository/);
  assert.doesNotMatch(await scope.locator('.body').innerText(), /Command failed|rev-parse/);
  assert.equal(await group.locator('.row').getAttribute('data-text'), detail);
  assert.equal(await group.locator('[data-act=copytext]').getAttribute('title'), 'Copy the Git error');
  const localOnly = scope.locator('[data-act=localonly]');
  assert.equal(await localOnly.getAttribute('aria-pressed'), 'false');
  await localOnly.click();
  assert.equal(await localOnly.getAttribute('aria-pressed'), 'true');
});

test('the collapsed pill moves away from the X-ray legend', async (t) => {
  const state = panelState(false, { ui: { open: false } });
  const page = await open(t, '/plain', state, { width: 700, height: 800 });
  const pill = page.locator('#paqvilo-panel .pill');
  const corner = async () =>
    pill.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return `${box.top < innerHeight / 2 ? 'top' : 'bottom'}-${box.left < innerWidth / 2 ? 'left' : 'right'}`;
    });
  assert.equal(await corner(), 'bottom-left');
  // An X-ray legend along the bottom edge, as wide as the bottom-left pill: the pill takes a corner it leaves free.
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'paqvilo-xray';
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<div class="legend" style="position:fixed;left:0;right:0;bottom:0;height:60px"></div>';
  });
  // A redraw places the pill again.
  await page.evaluate(panelUi, state);
  assert.equal(await corner(), 'top-left', 'the free corner nearest to where it was');
});

test('the target row appears only with another target, and Go only for a different one', async (t) => {
  const target = (siteName, port) => ({ siteName, envName: 'dev', origin: `http://127.0.0.1:${port}` });
  const single = panelState(false, {
    capabilities: { actions: false, targets: true },
    targets: [{ ...target('invented-portal', 0), origin }],
  });
  const page = await open(t, '/plain', single);
  const row = page.locator('#paqvilo-panel .targets');
  assert.equal(await row.isVisible(), false, 'this target alone is no choice');
  await page.evaluate(panelUi, { ...single, targets: [single.targets[0], target('other-portal', 9)] });
  assert.equal(await row.isVisible(), true);
  const go = row.locator('[data-target-go]');
  assert.equal(await go.isDisabled(), true, 'the current target needs no Go');
  await row.locator('select').selectOption('1');
  assert.equal(await go.isDisabled(), false);
  await row.locator('select').selectOption('0');
  assert.equal(await go.isDisabled(), true);
});

// The panel's Alt+Shift+O handler starts its mode request synchronously: counting in the page, in the same task as
// the key event, needs no wait for a request that must not come.
const modeRequestsOnShortcut = (page) =>
  page.evaluate(() => {
    let requested = 0;
    const api = window.__paqviloModelPanelApi;
    window.__paqviloModelPanelApi = (request) => {
      if (request.name !== 'mode') return api(request);
      requested++;
      return Promise.resolve({ ok: false, error: 'Invented: counted only' });
    };
    const fetched = window.__modeFetches;
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'O', code: 'KeyO', altKey: true, shiftKey: true, bubbles: true }),
    );
    window.__paqviloModelPanelApi = api;
    return requested + window.__modeFetches - fetched;
  });
// Counts the panel's mode requests over HTTP; installed before the panel, which keeps the fetch it found.
const countModeFetches = () => {
  window.__modeFetches = 0;
  const fetch = window.fetch;
  window.fetch = function (input, init) {
    if (String(input).endsWith('/__paqvilo/api/mode')) window.__modeFetches++;
    return fetch.call(this, input, init);
  };
};

for (const [name, modelDriven, extra, reloads] of [
  ['mirage dev', false, { mirageMode: true }, false],
  ['lense dev against the site’s local Mirage', false, { localSimulation: true }, true],
  ['model-driven local simulation', true, { localSimulation: true }, true],
])
  test(`${name} has no Local/Online switch; the shortcut does nothing`, async (t) => {
    const state = panelState(modelDriven, extra);
    const page = await open(t, '/plain', state, undefined, countModeFetches);
    const head = page.locator('#paqvilo-panel .head');
    assert.equal(await head.locator('[data-act=mode]').count(), 0);
    // Lense still reloads the page on save in front of a local Mirage; under mirage dev, Mirage reloads it itself.
    assert.equal(await head.locator('[data-act=live]').count(), reloads ? 1 : 0);
    assert.doesNotMatch(await page.locator('#paqvilo-panel .foot').innerText(), /online/);
    assert.equal(await modeRequestsOnShortcut(page), 0);
  });

test('the mode shortcut asks for Online where there is another version to show', async (t) => {
  for (const modelDriven of [false, true]) {
    const page = await open(t, '/plain', panelState(modelDriven), undefined, countModeFetches);
    assert.equal(await modeRequestsOnShortcut(page), 1, modelDriven ? 'model-driven' : 'Power Pages');
  }
});

test('in front of a local Mirage, Overrides compares with the served version, not a deployment', async (t) => {
  const state = panelState(false, { localSimulation: true });
  state.items[0] = { ...state.items[0], differs: true, edited: true, title: 'Invented form' };
  state.items[1] = { ...state.items[1], differs: false };
  const page = await open(t, '/plain', state);
  const scope = page.locator('#paqvilo-panel');
  const first = scope.locator('.row[data-rel="web-files/first.css"]');
  assert.equal(await first.locator('.main .name').innerText(), 'Invented form\nedited\ndiffers from served version');
  assert.match(await scope.locator('.row[data-rel="web-files/second.css"] .name').innerText(), /unchanged/);
  assert.equal(
    await first.locator('[data-act=diff]').getAttribute('title'),
    'Compare Invented form with the served version',
  );
  assert.deepEqual(
    await scope
      .locator('.filters [data-act=filter]')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent.replace(/\s+/g, ' ').trim())),
    ['All 2', 'Edited 1', 'Differs from served version 1'],
  );
  const body = await scope.locator('.body').innerText();
  assert.doesNotMatch(body, /deployed|Online/);
  for (const title of await scope.locator('.body [title]').evaluateAll((nodes) => nodes.map((node) => node.title)))
    assert.doesNotMatch(title, /deployed|Online/, title);
});

test('started with --no-overrides in front of a local Mirage, Back to local turns the overrides on', async (t) => {
  const page = await open(t, '/plain', panelState(false, { localSimulation: true, online: true }));
  const banner = page.locator('#paqvilo-panel .banner.grey');
  assert.match(await banner.innerText(), /exactly as your local Mirage serves it/);
  const asked = page.waitForRequest('**/__paqvilo/api/mode');
  await page.route('**/__paqvilo/api/mode', (route) => route.fulfill({ json: { ok: false, error: 'Invented stop' } }));
  await banner.locator('[data-act=mode][data-v=local]').click();
  assert.deepEqual((await asked).postDataJSON(), { online: false });
});

test('without a Git baseline Edited and "changed vs Git" are not offered; a zero filter is not shown', async (t) => {
  const state = panelState(false, { git: { baseline: { available: false } } });
  state.items[0] = { ...state.items[0], differs: true };
  const page = await open(t, '/plain', state);
  const scope = page.locator('#paqvilo-panel');
  assert.deepEqual(
    await scope.locator('.filters [data-act=filter]').evaluateAll((nodes) => nodes.map((node) => node.dataset.v)),
    ['all', 'differs'],
  );
  const changed = scope.locator('[data-act=scope][data-v=changed]');
  assert.equal(await changed.isDisabled(), true);
  assert.match(await changed.getAttribute('title'), /Needs a Git baseline/);
  // With a baseline, a filter with nothing to show is still left out.
  await page.evaluate(panelUi, { ...state, git: { baseline: { available: true } } });
  assert.deepEqual(
    await scope.locator('.filters [data-act=filter]').evaluateAll((nodes) => nodes.map((node) => node.dataset.v)),
    ['all', 'differs'],
    'no "Edited 0"',
  );
  assert.equal(await changed.isDisabled(), false);
});

test('turning X-ray off brings back the panel it replaced, on the same tab', async (t) => {
  const page = await open(t, '/plain', panelState(false, { ui: { open: true, tab: 'issues' } }));
  // A stand-in X-ray: its toggle announces the state the way the real one does.
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'paqvilo-xray';
    document.body.append(host);
    host.__px = {
      enabled: false,
      toggle(value) {
        const next = value ?? !this.enabled;
        if (next === this.enabled) return;
        this.enabled = next;
        host.dispatchEvent(
          new CustomEvent('paqvilo-xray', { bubbles: true, detail: { action: 'toggled', enabled: next } }),
        );
      },
      // As the real X-ray does: hiding paqvilo turns it off.
      update(next) {
        if (next.ui?.hidden && this.enabled) this.toggle(false);
      },
    };
  });
  const scope = page.locator('#paqvilo-panel');
  await scope.locator('.head [data-act=xray]').click();
  assert.equal(await scope.locator('.wrap.open').count(), 0, 'X-ray takes the panel’s place');
  await page.evaluate(() => document.getElementById('paqvilo-xray').__px.toggle(false));
  assert.equal(await scope.locator('.wrap.open').count(), 1, 'closing X-ray brings the panel back');
  assert.equal(await scope.locator('.tab[aria-selected=true]').getAttribute('data-v'), 'issues');
  // X-ray started while the panel was collapsed leaves it collapsed.
  await scope.locator('.head [data-act=close]').click();
  await page.evaluate(() => document.getElementById('paqvilo-xray').__px.toggle(true));
  await page.evaluate(() => document.getElementById('paqvilo-xray').__px.toggle(false));
  assert.equal(await scope.locator('.wrap.open').count(), 0);
  // Hiding paqvilo while X-ray replaces the open panel hides it; the panel does not come back.
  await scope.locator('.pill').click();
  await scope.locator('.head [data-act=xray]').click();
  await page.keyboard.press('Alt+Shift+KeyL');
  assert.equal(await page.evaluate(() => document.getElementById('paqvilo-xray').__px.enabled), false);
  assert.equal(await scope.locator('.wrap.open').count(), 0, 'hide everything keeps the panel hidden');
  assert.equal(await scope.locator('.wrap.hidden').count(), 1);
});

test('an error toast shows its whole message, wrapped inside the panel', async (t) => {
  const page = await open(t, '/plain', panelState(true));
  const message =
    'No editor command was found for "invented-editor". Set PAQVILO_EDITOR or the catalogue editor setting to a command on PATH, then open the file again.';
  await page.evaluate((error) => {
    window.__paqviloModelPanelApi = async () => ({ ok: false, error });
  }, message);
  await page.locator('#paqvilo-panel .row[data-rel="web-files/first.css"] [data-act=open]').first().click();
  const toast = page.locator('#paqvilo-panel .toast.show');
  await toast.waitFor();
  const shown = await toast.evaluate((node) => {
    const panel = node.offsetParent.getBoundingClientRect(),
      box = node.getBoundingClientRect();
    return {
      text: node.textContent,
      clipped: node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight,
      inside: box.left >= panel.left && box.right <= panel.right,
      wrapped: box.height > 2 * parseFloat(getComputedStyle(node).fontSize),
    };
  });
  assert.equal(shown.text, message);
  assert.equal(shown.clipped, false, 'no part of the message is cut off');
  assert.equal(shown.inside, true, 'the toast stays within the panel');
  assert.equal(shown.wrapped, true, 'the long message wraps onto more lines');
  // An error is an alert: screen readers announce it at once. A plain note stays a polite status.
  const live = () => toast.evaluate((node) => [node.getAttribute('role'), node.getAttribute('aria-live')]);
  assert.deepEqual(await live(), ['alert', 'assertive']);
  await page.evaluate(() => {
    window.__paqviloModelPanelApi = async () => ({ ok: true });
  });
  await page.locator('#paqvilo-panel .row[data-rel="web-files/first.css"] [data-act=open]').first().click();
  await page.locator('#paqvilo-panel .toast.show:not(.bad)').waitFor();
  assert.deepEqual(await live(), ['status', 'polite']);
  // The keyboard hint uses the same treatment.
  assert.equal(
    await page.locator('#paqvilo-panel .float').evaluate((node) => getComputedStyle(node).whiteSpace),
    'normal',
  );
});

test('a model-driven app without local web resources shows no "No Git baseline" chip', async (t) => {
  const state = panelState(true, {
    items: [],
    stats: { webFiles: 0 },
    git: { baseline: { available: false } },
    capabilities: { actions: false, targets: false, git: true },
  });
  const page = await open(t, '/plain', state);
  const gitline = page.locator('#paqvilo-panel .gitline');
  assert.doesNotMatch(await gitline.evaluate((node) => node.textContent), /No Git baseline/);
  // With web resources the chip is back, and it points to Issues only when Issues has the reason.
  await page.evaluate(panelUi, { ...state, stats: { webFiles: 2 } });
  const chip = gitline.locator('.commit', { hasText: 'No Git baseline' });
  assert.doesNotMatch(await chip.getAttribute('title'), /Issues says why|templates? and snippet/);
});

test('page CSS that matches the panel host leaves its box alone', async (t) => {
  const page = await open(t, '/host-css', panelState(false));
  const host = await page.locator('#paqvilo-panel').evaluate((node) => {
    const style = getComputedStyle(node);
    return [
      style.filter,
      style.opacity,
      style.rotate,
      style.transform,
      style.borderTopWidth,
      style.paddingTop,
      style.marginTop,
    ];
  });
  assert.deepEqual(host, ['none', '1', 'none', 'none', '0px', '0px', '0px']);
  // Its position is its own too: the open panel stays inside the window.
  const box = await page.locator('#paqvilo-panel .panel').boundingBox();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1280 && box.y + box.height <= 960, JSON.stringify(box));
});

test('the collapsed pill takes the nearest free place on its first draw, not a corner over a link', async (t) => {
  const page = await open(t, '/corners', panelState(false, { ui: { open: false } }));
  const covered = await page.evaluate(() => {
    const pill = document.getElementById('paqvilo-panel').shadowRoot.querySelector('.pill').getBoundingClientRect();
    return [...document.querySelectorAll('a')].filter((link) => {
      const r = link.getBoundingClientRect();
      return r.left < pill.right && r.right > pill.left && r.top < pill.bottom && r.bottom > pill.top;
    }).length;
  });
  assert.equal(covered, 0);
});

test('the header X-ray button is pressed while X-ray runs; Clear is off for an empty list; a project shows its name', async (t) => {
  const state = panelState(true, { siteLabel: 'Invented project', ui: { open: true, tab: 'activity' }, activity: [] });
  const page = await open(t, '/plain', state);
  const scope = page.locator('#paqvilo-panel');
  assert.equal(await scope.locator('.pill .lbl').innerText(), 'Invented project');
  assert.equal(await scope.locator('.head .tag:not(.env)').innerText(), 'Invented project');
  assert.equal(await scope.locator('[data-act=clear]').isDisabled(), true, 'nothing to clear');
  await page.evaluate(panelUi, { ...state, activity: [{ type: 'switch', text: 'Invented', at: 1 }] });
  assert.equal(await scope.locator('[data-act=clear]').isDisabled(), false);
  await page.evaluate(() =>
    document.dispatchEvent(new CustomEvent('paqvilo-xray', { detail: { action: 'toggled', enabled: true } })),
  );
  assert.equal(await scope.locator('.head [data-act=xray]').getAttribute('aria-pressed'), 'true');
  await page.evaluate(() =>
    document.dispatchEvent(new CustomEvent('paqvilo-xray', { detail: { action: 'toggled', enabled: false } })),
  );
  assert.equal(await scope.locator('.head [data-act=xray]').getAttribute('aria-pressed'), 'false');
});

test('Overrides puts its filters and scope directly under the search box', async (t) => {
  const state = panelState(false);
  state.items[0] = { ...state.items[0], differs: true };
  const page = await open(t, '/plain', state);
  const scope = page.locator('#paqvilo-panel');
  assert.equal(await scope.locator('.subtools .filters [data-act=filter]').count(), 2);
  assert.equal(await scope.locator('.body .filters').count(), 0, 'not between the groups');
  const [tools, filters, firstGroup] = await Promise.all(
    ['.tools', '.subtools .filters', '.body .group'].map((selector) =>
      scope
        .locator(selector)
        .first()
        .evaluate((node) => node.getBoundingClientRect().top),
    ),
  );
  assert.ok(tools < filters && filters < firstGroup);
});
