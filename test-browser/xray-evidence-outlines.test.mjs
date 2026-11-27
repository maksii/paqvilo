// @test-kind contract: Paqvilo's own X-ray design: outline colours and the legend say what each element's evidence says, limits are per view, non-rendered elements are reachable, a container answer leads a wrapper candidate and component parts are named in words
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

// Routed by page.route; nothing listens on this loopback port. `proofs` maps an element ID to the provider packet
// parts (facts, sourceRefs, mode) an invented provenance reader answers for it.
async function fixture(t, html, { report = {}, proofs = {} } = {}) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  ownedFixture(t).add(() => context.close());
  const page = await context.newPage();
  await page.route('**/*', (route) =>
    route.fulfill({
      contentType: new URL(route.request().url()).pathname === '/' ? 'text/html' : 'text/plain',
      body: new URL(route.request().url()).pathname === '/' ? html : '',
    }),
  );
  const data = { origin: 'http://127.0.0.1:11121', token: 'invented-outlines', provenanceSlot: '__inventedProvenance' };
  await page.goto(data.origin + '/');
  await page.evaluate((proofs) => {
    window.__inventedProvenance = {
      query(node, { scope, anchorGeneration }) {
        const own = proofs[node.id] ?? {};
        const facts = (own.facts ?? []).map((fact) => ({ ...fact, scope, renderSourceRevision: scope.sourceRevision }));
        const sourceRefs = (own.sourceRefs ?? []).map((ref) => ({ ...ref, sourceRevision: scope.sourceRevision }));
        return { version: 1, mode: own.mode ?? 'live', scope, anchorGeneration, facts, sourceRefs, availability: [] };
      },
    };
  }, proofs);
  await page.evaluate(xrayUi, data);
  await page.evaluate(
    ({ data, report }) => {
      const api = document.getElementById('paqvilo-xray').__px;
      api.update(data, report);
      api.toggle(true);
    },
    { data, report },
  );
  return { page, xray: page.locator('#paqvilo-xray') };
}

const literal = (ref) => ({
  facts: [
    { id: 'literal', dimension: 'source', kind: 'served-literal', sourceRefIds: [ref], region: { start: 0, end: 9 } },
  ],
  sourceRefs: [
    {
      id: ref,
      key: 'key-' + ref,
      ref: 'web-templates/' + ref + '.html',
      name: 'Invented ' + ref,
      contentRevision: 'c1',
    },
  ],
});
const owner = (binding, kind, mode = 'live') => ({
  mode,
  facts: [{ id: 'owner', dimension: 'owner', kind, predicate: 'identity', binding }],
});
const hint = (id) => ({
  kind: 'template',
  name: 'Wrapper',
  ref: 'web-templates/wrapper.html',
  selector: '#' + id,
  matchKind: 'id',
});
const box = 'display:block;width:120px;height:40px;margin:8px';

// The tone each element's outline is drawn in, read from the marks whose box is the element's box.
const tones = (page, ids) =>
  page.evaluate((ids) => {
    const marks = [...document.getElementById('paqvilo-xray').shadowRoot.querySelectorAll('.marks > div > .mark')];
    return Object.fromEntries(
      ids.map((id) => {
        const r = document.getElementById(id).getBoundingClientRect();
        const mark = marks.find((item) => {
          const m = item.getBoundingClientRect();
          return Math.abs(m.left - r.left) < 1 && Math.abs(m.top - r.top) < 1 && Math.abs(m.width - r.width) < 1;
        });
        return [
          id,
          mark
            ? mark.style.getPropertyValue('--tone') + (mark.classList.contains('unidentified') ? ' dashed' : '')
            : null,
        ];
      }),
    );
  }, ids);

test('outline colours follow the evidence of each element, and the legend names them', async (t) => {
  const html = `<!doctype html><body>
    <div id="markup" style="${box}"><span id="inside" style="${box};width:40px;height:20px"></span></div>
    <div id="generated" style="${box}"></div>
    <div id="shell" style="${box}"></div>
    <div id="form" style="${box}"></div>
    <input id="plain" style="${box}">`;
  const { page, xray } = await fixture(t, html, {
    report: { elementSources: ['markup', 'inside', 'generated', 'shell', 'form'].map(hint) },
    proofs: {
      markup: literal('markup'),
      generated: { ...literal('generated'), facts: [{ ...literal('generated').facts[0], kind: 'served-generated' }] },
      shell: owner({ kind: 'platform-shell', key: 'platform-shell:page', name: 'Page shell' }, 'served-platform'),
      form: owner(
        { kind: 'basic-form', key: 'basic-form:inv-form', id: 'inv-form', name: 'Invented form' },
        'render-platform',
        'local',
      ),
    },
  });
  const ids = ['markup', 'inside', 'generated', 'shell', 'form', 'plain'];
  await page.waitForFunction(
    (count) =>
      document.getElementById('paqvilo-xray').shadowRoot.querySelectorAll('.marks > div > .mark').length >= count,
    ids.length,
  );
  assert.deepEqual(await tones(page, ids), {
    markup: 'var(--tone-source)',
    inside: 'var(--tone-runtime)',
    generated: 'var(--tone-generated)',
    shell: 'var(--tone-portal)',
    form: 'var(--tone-component)',
    plain: 'var(--tone-none) dashed',
  });
  const legend = await xray.locator('.legend').innerText();
  for (const words of [
    'Markup from your sources',
    'Generated by Liquid',
    'Forms, lists & fields',
    'Added by the portal',
    'Created at runtime',
    'Not identified',
  ])
    assert.ok(legend.includes(words), `${words} in ${legend}`);
  // The layer choice keeps its meaning: Forms, lists & fields outlines the components only.
  await xray.getByRole('combobox', { name: 'Highlight layer' }).selectOption('data');
  await page.waitForFunction(
    () => document.getElementById('paqvilo-xray').shadowRoot.querySelectorAll('.marks > div > .mark').length === 1,
  );
  assert.deepEqual(await tones(page, ['form', 'markup']), { form: 'var(--tone-component)', markup: null });
});

test('a container answer leads a wrapper template candidate in the header and the hover summary', async (t) => {
  const html = `<!doctype html><body><div id="markup" style="${box}"><span id="inside" style="${box}">x</span></div>`;
  const { page, xray } = await fixture(t, html, {
    report: { elementSources: [hint('inside')] },
    proofs: { markup: literal('markup') },
  });
  const found = await page.evaluate(() => {
    const row = document.getElementById('paqvilo-xray').__px.identify(document.getElementById('inside'));
    return {
      title: row.title,
      kind: row.kind,
      contained: row.contained,
      likely: row.evidence.source.refs.map((ref) => ref.status),
    };
  });
  // The wrapper template matches the element's ID: it stays a candidate source row, never the header's answer.
  assert.ok(found.likely.includes('candidate'), JSON.stringify(found));
  assert.equal(found.contained, true);
  assert.equal(found.kind, 'Inside a known element');
  assert.equal(found.title, 'Inside Invented markup · div · span');
  // The shield covers the page while X-ray inspects: the pointer moves over the element's box.
  const r = await page.locator('#inside').boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await xray.locator('.tip:not([hidden])').waitFor();
  assert.match(await xray.locator('.tip').innerText(), /^Inside a known element\s+Inside Invented markup · div · span/);
  await page.evaluate(() => document.getElementById('paqvilo-xray').__px.select(document.getElementById('inside')));
  assert.equal(await xray.locator('.cardhead .eyebrow').innerText(), 'Inside a known element');
  assert.doesNotMatch(await xray.locator('.cardhead').innerText(), /Likely source file|Wrapper/);
});

test('Parent and Child reach elements that are not rendered: the scripts and stylesheets of the head', async (t) => {
  const html =
    '<!doctype html><html><head><script src="/invented.js"></script><link rel="stylesheet" href="/invented.css"></head><body><p id="p">Text</p></body></html>';
  const { page, xray } = await fixture(t, html);
  await page.evaluate(() => document.getElementById('paqvilo-xray').__px.select(document.head));
  const child = xray.locator('[data-action=child]');
  assert.equal(await child.isDisabled(), false, 'the head has children to select');
  await child.click();
  assert.equal(
    await page.evaluate(() => document.getElementById('paqvilo-xray').__px.selectedNode()?.localName),
    'script',
  );
  // The loading element is named by what it loads: a file of the page's own site.
  assert.equal(await xray.locator('.cardhead .eyebrow').innerText(), 'Not matched to any source');
  await page.keyboard.press('ArrowUp');
  assert.equal(
    await page.evaluate(() => document.getElementById('paqvilo-xray').__px.selectedNode()?.localName),
    'head',
  );
  // Down comes back to the child it came from.
  await page.keyboard.press('ArrowDown');
  assert.equal(
    await page.evaluate(() => document.getElementById('paqvilo-xray').__px.selectedNode()?.localName),
    'script',
  );
});

test('outline limits are per view and a selection is not incomplete because the page has many candidates', async (t) => {
  const html =
    '<!doctype html><body>' +
    '<input class="far" style="position:absolute;top:3000px">'.repeat(900) +
    `<input id="near" style="${box}">`;
  const { page, xray } = await fixture(t, html, { report: { elementSources: [] } });
  await page.waitForFunction(() =>
    document
      .getElementById('paqvilo-xray')
      .shadowRoot.querySelector('.legend .hint')
      .textContent.includes('click to select'),
  );
  assert.doesNotMatch(await xray.locator('.legend').innerText(), /800|250/);
  const truncated = await page.evaluate(() => {
    const api = document.getElementById('paqvilo-xray').__px;
    api.select(document.getElementById('near'));
    return api.selection().evidence.limits.truncated;
  });
  assert.equal(truncated, false);
  assert.equal(await xray.locator('[data-disclosure="evidence-limits"]').count(), 0);
});

test('a component part is named by its component and the part in words', async (t) => {
  const html = `<!doctype html><body><div id="summary" style="${box}"></div>`;
  const { page, xray } = await fixture(t, html, {
    report: { forms: [{ id: 'inv-form', name: 'Contact us', kind: 'basic-form' }] },
    proofs: {
      summary: owner(
        {
          kind: 'basic-form',
          key: 'basic-form:inv-form#validation-summary',
          id: 'inv-form',
          name: 'validation-summary',
          part: 'validation-summary',
        },
        'render-platform',
        'local',
      ),
    },
  });
  await page.evaluate(() => document.getElementById('paqvilo-xray').__px.select(document.getElementById('summary')));
  assert.equal(await xray.locator('.cardhead .eyebrow').innerText(), 'Basic form');
  assert.equal(await xray.locator('.cardhead .title').innerText(), 'Contact us · validation summary · div');
  assert.doesNotMatch(await xray.locator('.card').innerText(), /validation-summary/);
});
