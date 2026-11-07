import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { createSourceInspector, inspectRenderedPage } from '../lense/source-inspection.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';
import { inspectionFixture } from '../test/source-inspection-fixture.mjs';

const assertStaticCandidate = (evidence, name) => {
  assert.notEqual(evidence.owner.status, 'exact');
  assert.notEqual(evidence.source.status, 'exact');
  assert.ok(
    evidence.source.refs.some((ref) => ref.name === name && ref.status === 'candidate'),
    name,
  );
};

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

async function fixture(t, html) {
  const fx = inspectionFixture();
  ownedFixture(t).remove(fx.cleanup);
  const context = await browser.newContext();
  ownedFixture(t).add(() => context.close());
  const page = await context.newPage();
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto('http://127.0.0.1:11111/');
  const inspector = createSourceInspector({ sourceDir: fx.portal });
  const data = { origin: 'http://127.0.0.1:11111', token: 'invented-cached-xray' };
  const inspect = async () => {
    const { report } = await inspector.inspect('/', await page.evaluate(inspectRenderedPage));
    for (const row of report.elementSources)
      if (row.sourceFile) row.ref = path.relative(fx.portal, row.sourceFile).replaceAll('\\', '/');
    await page.evaluate(xrayUi, data);
    await page.evaluate(
      ({ data, report }) => {
        const api = document.getElementById('paqvilo-xray').__px;
        api.update(data, report);
        api.toggle(true);
      },
      { data, report },
    );
    return report;
  };
  return { fx, page, inspector, inspect };
}

test('observed declared grids hydrate both exported tables without page requests or form-table inference', async (t) => {
  const html =
    '<table data-paqvilo-table="fx_widget"><tr><th id="first" data-paqvilo-column="fx_title">First</th></tr></table>' +
    '<table data-paqvilo-table="fx_other"><tr><th id="second" data-paqvilo-column="fx_title">Second</th></tr></table>';
  const { fx, page } = await fixture(t, html);
  const other = path.join(fx.solution, 'Entities/fx_other/Entity.xml');
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(
    other,
    '<Entity><Name>fx_other</Name><EntityInfo><entity Name="fx_other"><EntitySetName>fx_others</EntitySetName><attributes><attribute PhysicalName="fx_title"><Type>nvarchar</Type><Name>fx_title</Name><LogicalName>fx_title</LogicalName></attribute></attributes></entity></EntityInfo></Entity>',
  );
  fs.writeFileSync(path.join(fx.portal, 'web-pages/other/Other.webpage.copy.html'), html);
  const inspector = createSourceInspector({ sourceDir: fx.portal, mirageConfig: { solutionRoots: [fx.solution] } });
  const rendered = await page.evaluate(inspectRenderedPage);
  assert.deepEqual(
    rendered.controls.filter((row) => row.gridTable).map((row) => row.gridTable),
    ['fx_widget', 'fx_other'],
  );
  const { report } = await inspector.inspect('/other', rendered);
  assert.deepEqual(report.apiReferences, []);
  assert.ok(
    report.columns.some(
      (row) => row.entity === 'fx_other' && row.name === 'fx_title' && row.evidence === 'declared-grid-table-candidate',
    ),
    JSON.stringify({
      columns: report.columns.map((row) => ({ entity: row.entity, name: row.name, evidence: row.evidence })),
      tables: report.tables.map((row) => row.logicalName),
    }),
  );
  const data = {
    origin: 'http://127.0.0.1:11111',
    token: 'declared-grid-source',
    sourceRevision: report.sourceRevision,
  };
  await page.evaluate(xrayUi, data);
  await page.evaluate(({ data, report }) => document.getElementById('paqvilo-xray').__px.update(data, report), {
    data,
    report,
  });
  const exactRefs = new Map();
  for (const [id, table] of [
    ['first', 'fx_widget'],
    ['second', 'fx_other'],
  ]) {
    const evidence = await page
      .locator('#' + id)
      .evaluate((node) => document.getElementById('paqvilo-xray').__px.identify(node).evidence);
    assert.equal(evidence.owner.status, 'exact');
    assert.equal(evidence.owner.component.key, 'column:' + table + ':fx_title');
    assert.equal(evidence.source.status, 'exact');
    const ref = evidence.source.refs.find((row) => row.status === 'exact');
    exactRefs.set(table, ref);
    const opened = await inspector.lookupSource({
      sourceKey: ref.key,
      sourceRevision: ref.sourceRevision,
      contentRevision: ref.contentRevision,
      route: '/other',
    });
    assert.equal(opened.state, 'exact', 'the admitted table remains available to the independent source-opening check');
  }
  // A real source edit reloads the inspector's sources; the table admitted from the rendered grid stays admitted.
  fs.appendFileSync(path.join(fx.portal, 'web-pages/other/Other.webpage.copy.html'), '<!-- edited -->');
  const admittedRef = exactRefs.get('fx_other');
  const reopened = await inspector.lookupSource({
    sourceKey: admittedRef.key,
    sourceRevision: admittedRef.sourceRevision,
    contentRevision: admittedRef.contentRevision,
    route: '/other',
  });
  assert.notEqual(reopened.reason, 'source-evidence-unavailable', 'a reload must not forget the admitted table');
  await page.locator('#second').evaluate((node) => node.closest('table').removeAttribute('data-paqvilo-table'));
  const unbound = await page
    .locator('#second')
    .evaluate((node) => document.getElementById('paqvilo-xray').__px.identify(node).evidence);
  assert.notEqual(
    unbound.owner.status,
    'exact',
    'hydrated metadata cannot keep ownership after its rendered declaration is removed',
  );
});

for (const clone of [false, true])
  test(`a selected ${clone ? 'linked clone' : 'declared grid'} beyond the control scan cap requests a bounded source refresh`, async (t) => {
    const { fx, page } = await fixture(
      t,
      '<input>'.repeat(900) +
        `<table id="late-original" data-paqvilo-table="fx_late"><tr><th ${clone ? '' : 'id="late"'} data-paqvilo-column="fx_title">Late</th></tr></table>` +
        (clone
          ? '<table data-paqvilo-grid="late-original"><tr><th id="late" data-paqvilo-column="fx_title">Clone</th></tr></table>'
          : ''),
    );
    const other = path.join(fx.solution, 'Entities/fx_late/Entity.xml');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(
      other,
      '<Entity><Name>fx_late</Name><EntityInfo><entity Name="fx_late"><attributes><attribute PhysicalName="fx_title"><Type>nvarchar</Type><LogicalName>fx_title</LogicalName></attribute></attributes></entity></EntityInfo></Entity>',
    );
    const inspector = createSourceInspector({ sourceDir: fx.portal, mirageConfig: { solutionRoots: [fx.solution] } });
    const rendered = await page.evaluate(inspectRenderedPage);
    assert.equal(
      rendered.controls.some((row) => row.gridTable === 'fx_late'),
      false,
      'the ordinary scan remains bounded',
    );
    const { report } = await inspector.inspect('/other', rendered);
    const data = {
      origin: 'http://127.0.0.1:11111',
      token: 'invented-selected-grid',
      sourceRevision: report.sourceRevision,
    };
    await page.evaluate(xrayUi, data);
    await page.evaluate(
      ({ data, report }) => {
        const api = document.getElementById('paqvilo-xray').__px;
        api.update(data, report);
        window.gridRefreshes = 0;
        document.getElementById('paqvilo-xray').addEventListener('paqvilo-xray', (event) => {
          if (event.detail.action === 'refresh') window.gridRefreshes++;
        });
        api.select(document.getElementById('late'));
      },
      { data, report },
    );
    await page.waitForFunction(() => window.gridRefreshes === 1);
    const focused = await page.evaluate(inspectRenderedPage);
    assert.equal(
      focused.controls[0].gridTable,
      'fx_late',
      'selection prioritizes the actual grid before unrelated inputs',
    );
    assert.ok(focused.controls.length <= 300, 'selected-grid priority preserves the control scan cap');
    const fresh = (await inspector.inspect('/other', focused)).report;
    await page.evaluate(({ data, report }) => document.getElementById('paqvilo-xray').__px.update(data, report), {
      data: { ...data, sourceRevision: fresh.sourceRevision },
      report: fresh,
    });
    const evidence = await page
      .locator('#late')
      .evaluate((node) => document.getElementById('paqvilo-xray').__px.identify(node).evidence);
    assert.equal(evidence.owner.status, 'exact');
    assert.equal(evidence.owner.component.key, 'column:fx_late:fx_title');
    assert.equal(evidence.source.status, 'exact');
    assert.equal(
      await page.evaluate(() => window.gridRefreshes),
      1,
      'hydration does not keep refreshing an exact selection',
    );
    if (clone) {
      await page.locator('#late-original').evaluate((node) => node.after(node.cloneNode(true)));
      const ambiguous = await page.evaluate(inspectRenderedPage);
      assert.equal(
        ambiguous.controls.some((row) => row.gridTable === 'fx_late'),
        false,
        'a duplicate clone target cannot choose which original to prioritize',
      );
      const ambiguousEvidence = await page
        .locator('#late')
        .evaluate((node) => document.getElementById('paqvilo-xray').__px.identify(node).evidence);
      assert.notEqual(
        ambiguousEvidence.owner.status,
        'exact',
        'admitted metadata cannot replace a unique clone target',
      );
    }
  });

test('first trusted selection renders its card and clipped outline without reading geometry after the card rebuild', async (t) => {
  const { page, inspect } = await fixture(
    t,
    '<div id="clip" style="width:180px;height:50px;overflow:hidden"><button id="target" style="width:300px;height:40px">Invented</button></div>',
  );
  await inspect();
  const point = await page.locator('#target').boundingBox();
  await page.evaluate(() => {
    const host = document.getElementById('paqvilo-xray'),
      target = document.getElementById('target'),
      clip = document.getElementById('clip');
    const targetRect = target.getBoundingClientRect(),
      clipRect = clip.getBoundingClientRect();
    const expected = {
      left: Math.max(targetRect.left, clipRect.left),
      top: Math.max(targetRect.top, clipRect.top),
      width: Math.min(targetRect.right, clipRect.right) - Math.max(targetRect.left, clipRect.left),
      height: Math.min(targetRect.bottom, clipRect.bottom) - Math.max(targetRect.top, clipRect.top),
    };
    const measure = Element.prototype.getBoundingClientRect,
      lateReads = [];
    window.selectionActivations = 0;
    target.addEventListener('click', () => window.selectionActivations++);
    Element.prototype.getBoundingClientRect = function (...args) {
      if (host.shadowRoot.querySelector('.card .title')) lateReads.push(this.localName);
      return measure.apply(this, args);
    };
    host.addEventListener(
      'paqvilo-xray',
      (event) => {
        if (event.detail.action !== 'selected') return;
        Element.prototype.getBoundingClientRect = measure;
        const outline = host.shadowRoot.querySelector('.selected');
        window.selectionGeometry = {
          lateReads,
          expected,
          title: event.detail.identity.title,
          cardTitle: host.shadowRoot.querySelector('.card .title')?.textContent,
          outline: outline
            ? Object.fromEntries(['left', 'top', 'width', 'height'].map((key) => [key, parseFloat(outline.style[key])]))
            : null,
        };
      },
      { once: true },
    );
  });
  await page.mouse.click(point.x + 20, point.y + 20);
  await page.waitForFunction(() => window.selectionGeometry);
  const result = await page.evaluate(() => ({ ...window.selectionGeometry, activations: window.selectionActivations }));
  assert.deepEqual(result.lateReads, [], 'the new source-card layout is left to the browser paint');
  assert.equal(result.cardTitle, result.title);
  assert.deepEqual(result.outline, result.expected, 'the clipped selection outline is present before notification');
  assert.equal(result.activations, 0);
});

test('script-rendered unreferenced snippets remain attributable with bounded page evidence and fast identification', async (t) => {
  const markup =
    '<aside id="dynamic-banner" class="notice dynamic"><span class="notice-message">Invented message</span></aside>';
  const { fx, page, inspector, inspect } = await fixture(
    t,
    `<main></main><script>document.querySelector('main').innerHTML=${JSON.stringify(markup)};</script>`,
  );
  fs.writeFileSync(
    path.join(fx.portal, 'content-snippets/Dynamic.contentsnippet.yml'),
    'adx_contentsnippetid: dynamic\nadx_name: Dynamic notice',
  );
  fs.writeFileSync(path.join(fx.portal, 'content-snippets/Dynamic.contentsnippet.value.html'), markup);
  const report = await inspect();
  assert.equal(
    report.snippets.some((row) => row.name === 'Dynamic notice'),
    false,
    'the dynamic insertion is absent from the static include graph',
  );
  assert.ok(report.elementSources.some((row) => row.name === 'Dynamic notice'));
  const result = await page.evaluate(() => {
    const api = document.getElementById('paqvilo-xray').__px,
      node = document.querySelector('.notice-message');
    const start = performance.now();
    let result;
    for (let index = 0; index < 100; index++) result = api.identify(node);
    return { evidence: result.evidence, ms: (performance.now() - start) / 100 };
  });
  assertStaticCandidate(result.evidence, 'Dynamic notice');
  assert.ok(result.ms < 5, 'synthetic element identification stays below the 5 ms target');
  t.diagnostic(JSON.stringify({ identificationMs: result.ms }));
  await page.locator('.notice-message').evaluate((node) => (node.className = 'replacement-message'));
  const after = await inspect();
  assert.ok(
    after.elementSources.some((row) => row.selector === '#dynamic-banner'),
    'the enclosing source ID survives script class changes',
  );
  fs.appendFileSync(
    path.join(fx.portal, 'content-snippets/Dynamic.contentsnippet.value.html'),
    '<span id="edited-dynamic"></span>',
  );
  await page
    .locator('#dynamic-banner')
    .evaluate((node) => node.insertAdjacentHTML('beforeend', '<span id="edited-dynamic"></span>'));
  inspector.invalidate();
  const edited = await inspect();
  assert.ok(edited.elementSources.some((row) => row.selector === '#edited-dynamic'));
  assertStaticCandidate(
    await page.evaluate(
      () =>
        document.getElementById('paqvilo-xray').__px.identify(document.querySelector('.replacement-message')).evidence,
    ),
    'Dynamic notice',
  );
});

test('script truncation notes and displayed source rows agree on root-relative forward-slash paths', async (t) => {
  const { fx, page, inspect } = await fixture(t, '<button id="id0">Invented button</button>');
  fs.writeFileSync(
    path.join(fx.portal, 'web-files/widget.js'),
    Array.from({ length: 200 }, (_, index) => `document.querySelector('#id${index}');`).join('\n'),
  );
  const report = await inspect();
  await page.evaluate(() => document.getElementById('paqvilo-xray').__px.select(document.getElementById('id0')));
  const text = await page.locator('#paqvilo-xray .content').textContent();
  const ref = report.elementSources.find((row) => row.kind === 'script' && row.selector === '#id0').ref;
  assert.ok(text.includes(ref));
  assert.ok(text.includes('Script index truncated; not attributed'));
  assert.ok(text.includes(ref));
  assert.equal(text.includes(fx.portal), false);
  assert.equal(/[A-Za-z]:\\/.test(text), false);
});

test('rendered IDs match exported hints across CSS escaping styles', async (t) => {
  const markup = '<aside id="é:notice"><span>Invented notice</span></aside>';
  const { fx, page, inspect } = await fixture(t, markup);
  fs.writeFileSync(
    path.join(fx.portal, 'content-snippets/Escaped.contentsnippet.yml'),
    'adx_contentsnippetid: escaped\nadx_name: Escaped notice',
  );
  fs.writeFileSync(path.join(fx.portal, 'content-snippets/Escaped.contentsnippet.value.html'), markup);
  const report = await inspect();
  assert.ok(report.elementSources.some((row) => row.name === 'Escaped notice'));
  assertStaticCandidate(
    await page.evaluate(
      () => document.getElementById('paqvilo-xray').__px.identify(document.querySelector('aside')).evidence,
    ),
    'Escaped notice',
  );
});

test('rendered markup hints exclude control values, page text, queries and arbitrary data attributes', async (t) => {
  const { page } = await fixture(
    t,
    '<div id="safe" class="fixture" data-private="PRIVATE_SENTINEL">TEXT_SENTINEL</div><input id="field" value="VALUE_SENTINEL"><a href="/?query=QUERY_SENTINEL">Link</a>',
  );
  const observed = await page.evaluate(inspectRenderedPage),
    text = JSON.stringify(observed);
  for (const sentinel of ['PRIVATE_SENTINEL', 'TEXT_SENTINEL', 'VALUE_SENTINEL', 'QUERY_SENTINEL'])
    assert.equal(text.includes(sentinel), false);
  assert.ok(observed.markupTokens.includes('id:safe'));
  assert.ok(observed.markupTokens.includes('class:div:fixture'));
});

test('rendered shape collection stops at its token budget and reports partial evidence', async (t) => {
  const { page } = await fixture(
    t,
    '<aside class="' + Array.from({ length: 9000 }, (_, index) => 'fixture' + index).join(' ') + '"></aside>',
  );
  const observed = await page.evaluate(inspectRenderedPage);
  assert.equal(observed.markupTokens.length, 8000);
  assert.equal(observed.truncated, true);
});

test('shape budget does not hide later controls or assets within the bounded document walk', async (t) => {
  const { page } = await fixture(
    t,
    '<div id="decoration">' +
      Array.from({ length: 2100 }, (_, i) => `<span class="decorative" id="shape-${i}"></span>`).join('') +
      '</div><form data-formid="later-form"><input id="later-field" name="later-field"></form><script src="/late-asset.js"></script>',
  );
  const evidence = await page.evaluate(inspectRenderedPage);
  assert.ok(evidence.controls.some((control) => control.id === 'later-field'));
  assert.ok(evidence.controls.some((control) => control.formId === 'later-form'));
  assert.ok(evidence.assets.some((asset) => asset.kind === 'script'));
  assert.ok(evidence.ids.length <= 2000);
  assert.ok(evidence.markupTokens.length <= 8000);
  assert.equal(evidence.truncated, true);
});

test('unreferenced snippets inserted in open shadow roots retain source candidates without collecting inspector internals', async (t) => {
  const markup = '<aside id="dynamic-shadow" class="shadow-notice"><slot></slot></aside>';
  const { fx, page, inspect } = await fixture(t, '<section id="host"><b id="slotted-light">Invented</b></section>');
  fs.writeFileSync(
    path.join(fx.portal, 'content-snippets/Shadow.contentsnippet.yml'),
    'adx_contentsnippetid: shadow\nadx_name: Shadow notice',
  );
  fs.writeFileSync(path.join(fx.portal, 'content-snippets/Shadow.contentsnippet.value.html'), markup);
  await page.evaluate(
    (markup) => (document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = markup),
    markup,
  );
  const report = await inspect();
  assert.ok(report.elementSources.some((row) => row.name === 'Shadow notice'));
  assertStaticCandidate(
    await page.evaluate(
      () =>
        document
          .getElementById('paqvilo-xray')
          .__px.identify(document.getElementById('host').shadowRoot.querySelector('aside')).evidence,
    ),
    'Shadow notice',
  );
  const observed = await page.evaluate(inspectRenderedPage);
  assert.ok(observed.ids.includes('dynamic-shadow'));
  assert.equal(
    observed.ids.filter((id) => id === 'slotted-light').length,
    1,
    'slot assignment does not visit the light node twice',
  );
  assert.equal(
    observed.markupTokens.some((token) => token.includes('paqvilo-xray') || token === 'class:div:shield'),
    false,
  );
});

test('an exact shadow ID remains attributable after an earlier common class reaches the candidate cap', async (t) => {
  const { fx, page, inspect } = await fixture(
    t,
    '<b class="crowded">Invented shared markup</b><section id="host"></section>',
  );
  const rows = Array.from({ length: 1250 }, (_, index) => ({
    adx_contentsnippetid: 'crowded-' + index,
    adx_name: 'Crowded ' + index,
    adx_value: '<b class="crowded"></b>',
  }));
  rows.push({
    adx_contentsnippetid: 'rare-shadow',
    adx_name: 'Exact shadow identity',
    adx_value: '<aside id="rare-shadow"></aside>',
  });
  fs.writeFileSync(path.join(fx.portal, 'contentsnippet.yml'), JSON.stringify(rows));
  await page.evaluate(
    () =>
      (document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<aside id="rare-shadow"></aside>'),
  );
  const report = await inspect();
  assert.equal(report.elementSourceLimits.candidateTruncated, true);
  const selected = await page.evaluate(
    () =>
      document
        .getElementById('paqvilo-xray')
        .__px.identify(document.getElementById('host').shadowRoot.querySelector('aside')).evidence,
  );
  assertStaticCandidate(selected, 'Exact shadow identity');
  assert.ok(
    selected.source.refs.every((ref) => ref.recordId === 'rare-shadow' && ref.fieldPath?.join('.') === 'value'),
    'shared-container siblings and metadata names are not markup candidates for this node',
  );
});

test('X-ray warns about oversized unreferenced sources without presenting them as selected-element matches', async (t) => {
  const { fx, page, inspect } = await fixture(t, '<aside id="oversize-visible">Invented</aside>');
  fs.writeFileSync(
    path.join(fx.portal, 'content-snippets/Oversize.contentsnippet.yml'),
    'adx_contentsnippetid: oversize\nadx_name: Oversize',
  );
  fs.writeFileSync(
    path.join(fx.portal, 'content-snippets/Oversize.contentsnippet.value.html'),
    '<aside id="oversize-visible">PRIVATE_BODY_SENTINEL</aside>' + ' '.repeat(1024 * 1024),
  );
  const report = await inspect();
  assert.equal(
    report.elementSources.some((row) => row.name === 'Oversize'),
    false,
  );
  await page.evaluate(() => document.getElementById('paqvilo-xray').__px.select(document.querySelector('aside')));
  await page.locator('#paqvilo-xray [data-evidence-role=limits] > summary').click();
  const text = await page.locator('#paqvilo-xray .content').innerText();
  assert.ok(text.includes('markupSources: 1'));
  assert.ok(text.includes('content-snippets/Oversize.contentsnippet.value.html'));
  assert.ok(text.includes('Index omissions; not attributed to the selected element'));
  assert.equal(text.includes('PRIVATE_BODY_SENTINEL'), false);
  assert.equal(text.includes(fx.portal), false);
});
