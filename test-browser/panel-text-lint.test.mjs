// @test-kind contract: the Lense panel is Paqvilo's own designed interface: no IDs, internal codes or symbol characters on screen, row kinds and status chips in words, one icon per meaning, and one kit look across the portal panel, the model-driven panel and X-ray
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { panelUi } from '../lense/panel-ui.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';
import { lenseUiKit } from '../lense/ui-kit.mjs';
import { panelSession } from './helpers/panel-session.mjs';

// Routed entirely by page.route; nothing listens on this loopback port.
const origin = 'http://127.0.0.1:11117';
const kit = lenseUiKit();
let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

const id = (n) => `fa110000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// An invented page report with the IDs and codes a real one carries: they must not reach the screen.
const report = {
  path: '/',
  evidence: { identity: 'Live web-role membership and effective record access are not available from the export.' },
  page: {
    id: id(1),
    pageName: 'Invented home',
    url: '/',
    pageTemplateName: 'Invented layout',
    publishingState: { name: 'Published', visible: true },
    access: {
      allowed: true,
      code: null,
      reason: 'public-or-role',
      rules: [
        {
          id: id(2),
          name: 'Invented restrict',
          right: 2,
          rightLabel: 'Restrict read',
          scopeLabel: 'All content',
          page: { url: '/' },
          roles: [{ id: id(3) }, { id: id(4), name: 'Readers' }],
          ref: 'web-pages/home/Home.webpage.yml',
        },
      ],
    },
  },
  pageSources: [
    { name: 'Root page metadata', ref: 'web-pages/home/Home.webpage.yml' },
    { name: 'Language page JavaScript', ref: 'web-pages/home/Home.en-US.webpage.custom_javascript.js' },
    { name: 'Language page copy', ref: 'web-pages/home/Home.en-US.webpage.copy.html' },
  ],
  webTemplates: [{ id: id(5), name: 'Invented header' }],
  templateChain: [
    { depth: 0, kind: 'page-template', id: id(6), name: 'Invented layout', ref: 'page-templates/layout.yml' },
    {
      depth: 1,
      kind: 'web-template',
      id: id(5),
      name: 'Invented header',
      via: 'Liquid include/layout',
      ref: 'web-templates/header.html',
    },
    // Mirage names this join by a code.
    {
      depth: 1,
      kind: 'web-template',
      id: id(13),
      name: 'Invented shell',
      via: 'page-template',
      ref: 'web-templates/shell.html',
    },
  ],
  tables: [
    {
      logicalName: 'inv_entry',
      displayName: 'Entry',
      entitySet: 'inv_entries',
      fieldCount: 11,
      ref: 'tables/inv_entry.yml',
      permissions: {
        mode: 'enforce',
        operations: {
          read: { allowed: false, reason: 'No grant for Anonymous Users' },
          create: { allowed: false, reason: 'No grant for Anonymous Users' },
          update: { allowed: true, scoped: true, reason: 'Contact scope' },
          delete: { allowed: false, reason: 'No grant for Anonymous Users' },
        },
      },
    },
  ],
  permissionRules: [
    {
      id: id(7),
      name: 'Invented grant',
      entity: 'inv_entry',
      scope: 'Global',
      operations: ['read'],
      roles: ['Readers'],
      parentPermissionId: id(8),
    },
  ],
  components: [{ kind: 'list', name: 'Invented list', recordId: id(9), entity: 'inv_entry', ref: 'lists/list.yml' }],
  usages: [
    {
      kind: 'entitylist',
      reference: id(9),
      expression: `{% entitylist id: '${id(9)}' %}`,
      owner: `web-template:${id(5)}`,
    },
    { kind: 'include', reference: 'Invented header', expression: "{% include 'Invented header' %}", owner: 'page' },
    {
      kind: 'entityform',
      reference: id(10),
      expression: `{% entityform id: '${id(10)}' %}`,
      owner: `web-template:${id(11)}`,
    },
  ],
  columns: [{ entity: 'inv_entry', name: 'inv_name', label: 'Name', type: 'string', ref: 'tables/inv_entry.yml' }],
  renderedControls: [
    { tag: 'input', type: 'text', id: 'inv_name', field: 'inv_name', evidence: 'rendered-and-source' },
    { tag: 'div', id: 'unmatched_one', evidence: 'rendered-only' },
    { tag: 'div', name: 'unmatched_two', evidence: 'rendered-only' },
  ],
  forms: [
    {
      id: id(14),
      name: 'Invented basic form',
      kind: 'basic-form',
      entity: 'inv_entry',
      ref: 'basic-forms/invented.yml',
      formXml: { name: 'Invented main form', ref: `solution/Entities/inv_entry/FormXml/main/{${id(15)}}.xml` },
    },
  ],
  snippets: [
    {
      name: 'Head/Favicon',
      value:
        '<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E">',
      ref: 'content-snippets/favicon.yml',
    },
  ],
  unresolved: [
    {
      kind: 'include',
      expression: '{% include page.adx_template %}',
      reason: 'Uses a Liquid variable.',
      owner: `web-template:${id(5)}`,
    },
  ],
};

const tweaks = {
  ok: true,
  permissionMode: 'enforce',
  permissionSource: 'exported',
  personas: [],
  presets: [],
  scenarios: [],
  tables: ['inv_entry'],
};

async function openPanel(t, { tab, mirageMode = true, mode = 'local-runtime', extra = {} }) {
  const { state, page } = await panelSession(t, browser, origin);
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/__paqvilo/api/')) {
      const action = url.pathname.split('/').at(-1);
      if (action === 'inspect') return route.fulfill({ json: { ok: true, version: 1, report } });
      return route.fulfill({ json: action === 'tweaks' ? tweaks : { ok: true } });
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><main><input id="inv_name"></main>' });
  });
  await page.goto(origin + '/?id=' + id(12));
  Object.assign(state, { ui: { open: true, tab }, mirageMode, ...extra });
  const runtime = {
    active: true,
    version: 1,
    mode,
    status: { site: 'Invented site', format: 'standard', revision: 3, sourceFingerprint: 'abcdef0123456789' },
  };
  state.mirage = mirageMode ? runtime : undefined;
  state.inspection = runtime;
  await page.evaluate(panelUi, state);
  return { state, page, panel: (selector) => page.locator('#paqvilo-panel').locator(selector) };
}

/** A kit icon as the browser serializes it once drawn. */
const drawn = (page, name) =>
  page.evaluate((markup) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.innerHTML = markup;
    return svg.innerHTML;
  }, kit.ICON[name]);

/** Visible text and attributes that break the panel's wording rules, collected in the page. */
const lint = (page) =>
  page.evaluate(() => {
    const root = document.getElementById('paqvilo-panel').shadowRoot;
    const found = [];
    const guid = /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/i;
    const code = /\b[a-z]+(?:-[a-z]+){2,}\b|\b[A-Z]+(?:_[A-Z]+)+\b|\b[a-z]+-[a-z]+:/;
    const glyph = /[⎇≠↳→←↑↓×✓✔★☆◉⊘▼▲▶◀]/;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.data.trim();
      const parent = node.parentElement;
      if (!text || !parent?.getClientRects().length || parent.closest('.path, style')) continue;
      if (guid.test(text) || code.test(text) || glyph.test(text) || /_sim\b/.test(text)) found.push(`text: ${text}`);
    }
    for (const element of root.querySelectorAll('[title]')) {
      const title = element.getAttribute('title');
      if (!title.trim()) found.push(`empty title on ${element.outerHTML.slice(0, 80)}`);
      else if (title.trim() === element.textContent.trim()) found.push(`title repeats its text: ${title}`);
      if (guid.test(title) && !element.closest('.path')) found.push(`title with an ID: ${title}`);
      if (/_sim\b/.test(title)) found.push(`title names _sim: ${title}`);
    }
    return found;
  });

test('Inspect shows names and words, never IDs or codes, and one icon per meaning', async (t) => {
  const { page, panel } = await openPanel(t, { tab: 'runtime' });
  await panel('[data-group="runtime-tables"]').waitFor();
  assert.deepEqual(await lint(page), []);
  // The access verdict says why in words (Mirage reports "public-or-role").
  assert.match(
    await panel('.card .srcs').filter({ hasText: 'Current persona' }).innerText(),
    /allowed\s+No page access rule restricts this page/,
  );
  // A table names itself first, its logical name beside it; operations are words; one reason is said once.
  const table = panel('[data-group="runtime-tables"] .row');
  assert.equal(await table.locator('.name > span:first-child').innerText(), 'Entry');
  assert.equal(await table.locator('.name .what').innerText(), 'inv_entry');
  assert.deepEqual(await table.locator('.c').allInnerTexts(), ['no read', 'no create', 'update, scoped', 'no delete']);
  const sub = await table.locator('.sub').innerText();
  assert.match(sub, /No grant for Anonymous Users: read, create, delete/);
  assert.equal(sub.match(/No grant for Anonymous Users/g).length, 1, sub);
  assert.match(sub, /11 columns in your sources/);
  // Components by name; the owner is the template's name; the Liquid line only when the reference is dynamic.
  const components = await panel('[data-group="runtime-components"] .row').allInnerTexts();
  assert.ok(
    components.some((row) => /List: Invented list[\s\S]*in web template Invented header/.test(row)),
    components.join('|'),
  );
  assert.ok(
    components.some((row) => /Basic form not in your sources[\s\S]*in a web template/.test(row)),
    components.join('|'),
  );
  assert.ok(!components.some((row) => row.includes('{% include')), 'an include names its template once');
  // Rendered controls: matched ones are rows; the others are listed under their own group, each saying why (E14).
  const rendered = panel('[data-group="runtime-rendered"]');
  assert.equal(await rendered.locator('.row').count(), 1);
  const unmatched = panel('[data-group="runtime-rendered-unmatched"] .row');
  assert.deepEqual(await unmatched.locator('.name > span:first-child').allInnerTexts(), [
    'unmatched_one',
    'unmatched_two',
  ]);
  assert.deepEqual(await unmatched.locator('.c').allInnerTexts(), ['not found', 'not found']);
  // A page source's kind is what the file is; its name says so already, so the column stays empty (its tooltip names it).
  const pageSources = panel('[data-group="runtime-page-sources"] .ico');
  assert.deepEqual(await pageSources.allInnerTexts(), ['', '', '']);
  assert.deepEqual(await pageSources.evaluateAll((nodes) => nodes.map((node) => node.title)), [
    'Web page metadata',
    'Page JavaScript',
    'Page copy',
  ]);
  // Row kinds are words from the kit, never the row's own word again.
  const labels = new Set(['Page template', 'Template', 'Table', 'Permission']);
  const kinds = (await panel('.body .ico').allInnerTexts()).filter(Boolean);
  assert.ok(kinds.length > 8);
  for (const kind of kinds) assert.match(kind, /^[A-Z][a-z]+(?: [a-zA-Z]+)?$|^C#$|^Web API$|^FetchXML$/, kind);
  for (const row of await panel('.body .row').all()) {
    const [kind, name] = await Promise.all([
      row.locator('.ico').innerText(),
      row.locator('.name > span').first().innerText(),
    ]);
    if (kind) assert.ok(!name.toLowerCase().split(/\W+/).includes(kind.toLowerCase()), `${kind} | ${name}`);
  }
  // A Solution file named by an ID reads "{…}"; the full path is the tooltip.
  const formXml = panel('[data-group="runtime-forms"] .row')
    .filter({ hasText: 'Invented main form' })
    .locator('.sub.path');
  assert.equal(await formXml.innerText(), 'solution/Entities/inv_entry/FormXml/main/{…}.xml');
  assert.match(await formXml.getAttribute('title'), /\{fa110000-0000-4000-8000-000000000015\}\.xml$/);
  // A row opens with its own click: no second open button beside it.
  assert.equal(await panel('.body .row .acts [data-act=open]').count(), 0);
  // Snippet markup reads as a summary; the value is its tooltip and has its own Copy.
  const snippet = panel('[data-group="runtime-snippets"] .row');
  assert.equal(await snippet.locator('.sub').innerText(), 'HTML · 1 line · link');
  assert.match(await snippet.locator('.sub').getAttribute('title'), /^<link rel="icon"/);
  assert.equal(await snippet.locator('[data-copy-kind=value]').count(), 1);
  assert.ok(
    [...labels].every((label) => kinds.includes(label)),
    kinds.join(','),
  );
  // Locating a field is the locate icon, opening _sim the _sim icon; "go" is navigation only.
  const svg = (selector) =>
    panel(selector)
      .first()
      .locator('svg')
      .evaluate((node) => node.innerHTML);
  assert.equal(await svg('[data-act=inspect-locate]'), await drawn(page, 'locate'));
  assert.equal(await svg('.body [data-act=sim]'), await drawn(page, 'sim'));
  // Commands are icon buttons in the search row; the sections are filter chips on one line under it, above the
  // selection, so the selection never moves them.
  for (const act of ['inspect-refresh', 'inspect-pick', 'inspect-fold']) {
    const button = panel(`.tools [data-act=${act}]`);
    assert.equal(await button.getAttribute('class'), 'ib', act);
    assert.ok((await button.getAttribute('title')).length > 10, act);
  }
  const sections = panel('.subtools [data-act=inspect-section]');
  assert.match(await sections.first().getAttribute('class'), /^f\b/);
  assert.equal(
    new Set(await sections.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top))))
      .size,
    1,
    'the section chips stay on one line',
  );
});

test('a live portal says what Inspect cannot know about web roles', async (t) => {
  const { panel } = await openPanel(t, { tab: 'runtime', mirageMode: false, mode: 'live-sources' });
  const card = panel('.card').filter({ hasText: 'Invented home' });
  await card.waitFor();
  assert.match(await card.innerText(), /Live web-role membership and effective record access are not available/);
  assert.equal(await card.getByText('Current persona').count(), 0);
});

test('the Mirage tab rows have an icon kind and open Mirage admin with the Mirage icon; no fingerprint is shown', async (t) => {
  const { page, panel } = await openPanel(t, { tab: 'mirage' });
  await panel('.row').filter({ hasText: 'Invented site' }).waitFor();
  assert.deepEqual(await lint(page), []);
  assert.doesNotMatch(await panel('.body').innerText(), /abcdef01|fingerprint|runtime state/i);
  // The column is a kit icon: the row's name already says what it is.
  for (const row of await panel('.body .row').all()) {
    assert.equal(await row.locator('.ico.icon svg').count(), 1);
    assert.equal(await row.locator('.ico').innerText(), '');
  }
  for (const button of await panel('.body .ib[data-act=sim], .body .ib[data-act=admin]').all())
    assert.equal(await button.locator('svg').evaluate((node) => node.innerHTML), await drawn(page, 'sim'));
  assert.equal(
    await panel('.row').filter({ hasText: 'inv_entry' }).locator('.sub').innerText(),
    'at this page’s record',
  );
});

test('Issues and Activity name each row kind in words, the same word for the same meaning', async (t) => {
  const extra = {
    needsDeploy: [{ rel: 'web-templates/header.html', reason: 'Invented change needs a deployment' }],
    notes: [{ kind: 'skipped', rel: 'web-files/a.css', reason: 'Invented note' }],
    problems: [
      { type: 'error', text: 'Invented error' },
      { type: 'http', text: 'Invented request', status: 500 },
    ],
    activity: [
      { type: 'deploy', text: 'Invented deployment note', at: 1 },
      { type: 'save', how: 'css', text: 'Invented styles', at: 2 },
    ],
  };
  const { page, panel } = await openPanel(t, { tab: 'issues', extra });
  await panel('.body .row').first().waitFor();
  assert.deepEqual(await lint(page), []);
  assert.deepEqual(await panel('.body .ico').allInnerTexts(), ['Deploy', 'Note', 'Error', 'Request']);
  await panel('[role=tab][data-v=activity]').click();
  assert.deepEqual(await panel('.body .ico').allInnerTexts(), ['Deploy', 'Style']);
});

test('the selected element is open on Inspect and folded on the other tabs, under a kit group header', async (t) => {
  const { panel, page } = await openPanel(t, { tab: 'runtime' });
  await panel('[data-group="runtime-tables"]').waitFor();
  await page.evaluate(() =>
    document.dispatchEvent(
      new CustomEvent('paqvilo-xray', {
        detail: {
          action: 'selected',
          reason: 'invented',
          scope: { uiEpoch: 1 },
          anchorId: 'a1',
          selectionGeneration: 1,
          element: { tag: 'input' },
          identity: { title: 'Invented name field', kind: 'Column', evidence: null },
        },
      }),
    ),
  );
  const summary = panel('[data-selected-identity]');
  await summary.waitFor();
  const isOpen = () => summary.evaluate((node) => node.open);
  assert.equal(await isOpen(), true);
  assert.equal(await summary.locator('summary').getAttribute('class'), 'gh', 'the kit header with its chevron');
  assert.equal(await summary.locator('summary svg').evaluate((node) => node.innerHTML), await drawn(page, 'right'));
  // The header reads as X-ray's card header: the kind, then the name; never "Selected:" with nothing after it.
  assert.equal(await summary.locator('.sel-head .eyebrow').innerText(), 'Column');
  assert.equal(await summary.locator('.sel-name').isVisible(), true);
  assert.equal(await summary.locator('.sel-name').innerText(), 'Invented name field');
  await panel('[role=tab][data-v=issues]').click();
  assert.equal(await isOpen(), false, 'folded above another tab');
  assert.equal(await summary.locator('.sel-name').innerText(), 'Invented name field');
  // On one tab the user's choice stays.
  await summary.locator('summary').click();
  assert.equal(await isOpen(), true);
  await panel('[role=tab][data-v=runtime]').click();
  assert.equal(await isOpen(), true);
});

// The same kit control looks the same wherever Lense draws it.
test('kit controls compute the same style in the portal panel, the model-driven panel and X-ray', async (t) => {
  const PROBES = [
    '<button class="ib">i</button>',
    '<button class="f">f</button>',
    '<button class="f on">f</button>',
    '<button class="btn">b</button>',
    '<button class="btn sec">b</button>',
    '<div class="gh">g</div>',
    '<div class="row"><div class="main"><div class="name"><span>n</span></div><div class="sub">s</div></div></div>',
    '<span class="c ok">c</span>',
    '<span class="c warn">c</span>',
    '<span class="c bad">c</span>',
    '<span class="c muted">c</span>',
    '<span class="n ok">1</span>',
    '<div class="empty"><b>e</b>e</div>',
    '<div class="banner">b</div>',
    '<kbd>k</kbd>',
    '<span class="ico">Template</span>',
  ];
  const PROPS = [
    'font-size',
    'font-weight',
    'line-height',
    'color',
    'background-color',
    'border-top-color',
    'border-radius',
    'padding-left',
    'padding-top',
  ];
  const measure = (page, hostId, container) =>
    page.evaluate(
      ({ hostId, container, probes, props }) => {
        const root = document.getElementById(hostId).shadowRoot;
        const box = document.createElement('div');
        box.innerHTML = probes.join('');
        root.querySelector(container).append(box);
        const styles = [...box.querySelectorAll('*')].map((node) => {
          const style = getComputedStyle(node);
          return `${node.tagName}.${node.className}: ${props.map((name) => style.getPropertyValue(name)).join(' | ')}`;
        });
        box.remove();
        return styles;
      },
      { hostId, container, probes: PROBES, props: PROPS },
    );
  const portal = await openPanel(t, { tab: 'issues' });
  await portal.panel('.body .empty').waitFor();
  const portalStyles = await measure(portal.page, 'paqvilo-panel', '.body .content');
  const modelDriven = await openPanel(t, { tab: 'issues', mirageMode: false, extra: { modelDriven: true } });
  await modelDriven.panel('.body .empty').waitFor();
  assert.deepEqual(await measure(modelDriven.page, 'paqvilo-panel', '.body .content'), portalStyles);
  await modelDriven.page.evaluate(xrayUi, { origin, token: 'invented-lint' });
  const xrayStyles = await measure(modelDriven.page, 'paqvilo-xray', '.card');
  assert.deepEqual(xrayStyles, portalStyles);
});
