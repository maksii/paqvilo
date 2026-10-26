// Report and source-hint reuse across revisits and refreshes. Parse counts are
// process-global, so these tests run in order; budgets and LRU eviction have
// their own files so the runner can execute them in parallel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createSourceInspector } from '../lense/source-inspection.mjs';
import { elementSourceHintCacheStats } from '../lense/element-provenance.mjs';
import { inspectionFixture } from './source-inspection-fixture.mjs';
import { settleFileTimes } from '../mirage/test/support/file-times.mjs';

test('X-ray report size follows page candidates, revisits reuse reports, and refresh parses only changed markup', async (t) => {
  // The reuse assertions below concern files written moments ago.
  settleFileTimes(t);
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  const config = { sourceDir: fx.portal };
  const small = await createSourceInspector(config).inspect('/');
  const body = (index) =>
    Array.from({ length: 20 }, (_, part) => `<div class="unused-${index}-${part}"></div>`).join('');
  fs.writeFileSync(
    path.join(fx.portal, 'webtemplate.yml'),
    JSON.stringify(
      Array.from({ length: 400 }, (_, index) => ({
        adx_webtemplateid: 'unused-template-' + index,
        adx_name: 'Unused template ' + index,
        adx_source: body(index),
      })),
    ),
  );
  fs.writeFileSync(
    path.join(fx.portal, 'contentsnippet.yml'),
    JSON.stringify(
      Array.from({ length: 600 }, (_, index) => ({
        adx_contentsnippetid: 'unused-snippet-' + index,
        adx_name: 'Unused snippet ' + index,
        adx_value: body(index + 400),
      })),
    ),
  );
  const inspector = createSourceInspector(config),
    start = performance.now(),
    first = await inspector.inspect('/');
  const firstMs = performance.now() - start;
  assert.ok(
    JSON.stringify(first.report).length < JSON.stringify(small.report).length * 2,
    'unused markup and its class-frequency dictionary stay out of the page response',
  );
  assert.equal(
    first.report.elementSources.some((row) => row.name.startsWith('Unused')),
    false,
  );
  const afterFirst = elementSourceHintCacheStats(),
    firstWork = inspector.stats();
  await inspector.inspect('/other');
  const beforeRevisit = elementSourceHintCacheStats(),
    revisitStart = performance.now();
  const revisit = await inspector.inspect('/');
  const revisitMs = performance.now() - revisitStart;
  assert.deepEqual(revisit, first);
  assert.equal(elementSourceHintCacheStats().parses, beforeRevisit.parses);
  assert.equal(inspector.stats().enrichments, firstWork.enrichments + 1, 'only the intervening route is enriched');
  const beforeRefresh = inspector.stats();
  for (let count = 0; count < 2; count++) {
    inspector.invalidate();
    assert.deepEqual(await inspector.inspect('/'), first);
  }
  assert.equal(inspector.stats().reloads, beforeRefresh.reloads);
  assert.equal(inspector.stats().sourceFiles.misses, beforeRefresh.sourceFiles.misses);
  assert.equal(
    elementSourceHintCacheStats().parses,
    afterFirst.parses,
    'unchanged refresh does not reparse any markup',
  );
  const changed = path.join(fx.portal, 'web-templates/Partial.webtemplate.source.html');
  fs.appendFileSync(changed, '<aside id="changed-markup"></aside>');
  inspector.invalidate();
  const updated = await inspector.inspect('/');
  assert.ok(updated.report.elementSources.some((row) => row.selector === '#changed-markup'));
  assert.equal(elementSourceHintCacheStats().parses, afterFirst.parses + 1, 'exactly the changed source is reparsed');
  assert.equal(inspector.stats().reloads, beforeRefresh.reloads + 1);
  t.diagnostic(
    JSON.stringify({
      firstMs,
      revisitMs,
      payloadBytes: Buffer.byteLength(JSON.stringify(first.report)),
      unusedTemplates: 400,
      unusedSnippets: 600,
    }),
  );
});

test('one inspection reads each exported source once for its shared source index', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  const target = fs.realpathSync(path.join(fx.portal, 'web-templates/Partial.webtemplate.source.html'));
  const inspector = createSourceInspector({ sourceDir: fx.portal });
  const opens = t.mock.method(fs, 'openSync');
  const { report } = await inspector.inspect('/');
  const reads = opens.mock.calls.filter(({ arguments: [file] }) => path.resolve(String(file)) === target).length;
  opens.mock.restore();
  assert.ok(report.portalSources.some((source) => source.sourceFile === target && source.ref));
  // The export index, enrichment and final snapshot share one guarded index build.
  assert.equal(reads, 1);
});

test('Mirage enrichment reuses unchanged route evidence while separating access verdicts and new rendered bindings', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  const inspector = createSourceInspector({ sourceDir: fx.portal });
  const base = {
    path: '/',
    page: { id: 'home', access: { allowed: false } },
    forms: [],
    columns: [],
    components: [],
    tables: [],
    unresolved: [],
  };
  await inspector.enrich(structuredClone(base));
  const first = inspector.stats();
  await inspector.enrich({ ...structuredClone(base), path: '/other', page: { id: 'other' } });
  const cached = await inspector.enrich(structuredClone(base));
  assert.equal(inspector.stats().reportHits, first.reportHits + 1);
  assert.equal(inspector.stats().enrichments, first.enrichments + 1);
  assert.equal(cached.page.access.allowed, false);
  cached.page.access.allowed = true;
  assert.equal(
    (await inspector.enrich(structuredClone(base))).page.access.allowed,
    false,
    'caller mutation cannot poison cached session evidence',
  );
  const allowed = await inspector.enrich({ ...structuredClone(base), page: { id: 'home', access: { allowed: true } } });
  assert.equal(allowed.page.access.allowed, true, 'a changed local access verdict has a separate cache key');
  await inspector.enrich(structuredClone(base), { controls: [{ entity: 'fx_widget', formId: 'widget-edit' }] });
  assert.equal(inspector.stats().enrichments, first.enrichments + 3, 'new rendered bindings are enriched again');
});

test('an edit during import is observed by the next refresh instead of becoming an accepted stale snapshot', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  const target = path.join(fx.portal, 'web-templates/Partial.webtemplate.source.html');
  const original = fs.promises.readFile;
  let edited = false;
  t.mock.method(fs.promises, 'readFile', async function (file, ...options) {
    const value = await original.call(this, file, ...options);
    if (!edited && path.resolve(String(file)) === target) {
      edited = true;
      await fs.promises.appendFile(target, '<b id="edited-during-import"></b>');
    }
    return value;
  });
  const inspector = createSourceInspector({ sourceDir: fx.portal });
  const first = await inspector.inspect('/');
  assert.equal(edited, true);
  assert.equal(
    first.report.elementSources.some((row) => row.selector === '#edited-during-import'),
    false,
  );
  inspector.invalidate();
  assert.ok(
    (await inspector.inspect('/')).report.elementSources.some((row) => row.selector === '#edited-during-import'),
  );
});

test('shared header/footer hints reuse parsing across pages and refresh, with whole-export rarity and form identities', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  fs.appendFileSync(
    path.join(fx.portal, 'website.yml'),
    '\nadx_headerwebtemplateid: header\nadx_footerwebtemplateid: footer',
  );
  for (const [name, id] of [
    ['Header', 'header'],
    ['Footer', 'footer'],
  ]) {
    fs.writeFileSync(
      path.join(fx.portal, `web-templates/${name}.webtemplate.yml`),
      `adx_webtemplateid: ${id}\nadx_name: ${name}`,
    );
    fs.writeFileSync(
      path.join(fx.portal, `web-templates/${name}.webtemplate.source.html`),
      `<aside id="${id}"><b class="shared-banner">Shared</b></aside>`,
    );
  }
  fs.writeFileSync(
    path.join(fx.portal, 'basic-forms/Unreferenced.basicform.yml'),
    'adx_entityformid: unreferenced\nadx_name: Unreferenced\nadx_entityname: fx_widget',
  );
  fs.writeFileSync(
    path.join(fx.portal, 'Wizard.advancedform.yml'),
    'adx_webformid: wizard\nadx_name: Unreferenced wizard',
  );
  fs.writeFileSync(
    path.join(fx.portal, 'Items.list.yml'),
    'adx_entitylistid: inventory-list\nadx_name: Unreferenced list\nadx_entityname: fx_widget',
  );
  const inspector = createSourceInspector({ sourceDir: fx.portal }),
    first = (await inspector.inspect('/')).report,
    before = elementSourceHintCacheStats();
  const second = (await inspector.inspect('/other/')).report;
  assert.equal(second.elementSourceFrequencies['b.shared-banner'], 2, 'relevant candidates retain whole-export rarity');
  assert.equal(
    first.elementSourceFrequencies['b.shared-banner'],
    undefined,
    'the bare-shell page omits unrelated frequency entries',
  );
  assert.equal(
    elementSourceHintCacheStats().parses,
    before.parses,
    'The second page does not parse shared files again',
  );
  assert.ok(!first.forms.some((row) => row.id === 'unreferenced'));
  assert.ok(first.componentIndex.forms.some((row) => row.id === 'unreferenced'));
  assert.ok(
    first.componentIndex.forms.some(
      (row) => row.id === 'wizard' && row.kind === 'advanced-form' && row.pageReferenced === false,
    ),
  );
  assert.ok(first.componentIndex.lists.some((row) => row.id === 'inventory-list' && row.pageReferenced === false));
  inspector.invalidate();
  await inspector.inspect('/other/');
  assert.equal(elementSourceHintCacheStats().parses, before.parses, 'Unchanged refresh reuses source hints');
  fs.appendFileSync(
    path.join(fx.portal, 'web-templates/Header.webtemplate.source.html'),
    '<div id="new-header"></div>',
  );
  inspector.invalidate();
  const changed = (await inspector.inspect('/other/')).report;
  assert.ok(changed.elementSources.some((row) => row.selector === '#new-header'));
  assert.equal(elementSourceHintCacheStats().parses, before.parses + 1);
});

test('600 source reports survive A/B/A and unchanged refresh without reparsing markup', async (t) => {
  // The reuse assertions concern files written moments ago; stamps inside their time tick are never trusted.
  settleFileTimes(t);
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  for (let i = 0; i < 600; i++) {
    fs.writeFileSync(
      path.join(fx.portal, `web-templates/S${i}.webtemplate.yml`),
      `adx_webtemplateid: s${i}\nadx_name: S${i}`,
    );
    fs.writeFileSync(
      path.join(fx.portal, `web-templates/S${i}.webtemplate.source.html`),
      `<aside class="s${i}">Invented</aside>`,
    );
  }
  fs.appendFileSync(
    path.join(fx.portal, 'web-pages/home/Home.webpage.copy.html'),
    Array.from({ length: 600 }, (_, i) => `{% include 'S${i}' %}`).join('\n'),
  );
  const inspector = createSourceInspector({ sourceDir: fx.portal });
  const first = await inspector.inspect('/'),
    parses = elementSourceHintCacheStats().parses;
  await inspector.inspect('/other/');
  first.report.pageSources.length = 0;
  const again = await inspector.inspect('/');
  assert.ok(again.report.pageSources.length > 0, 'cached reports are independent');
  assert.equal(elementSourceHintCacheStats().parses, parses);
  inspector.invalidate();
  await inspector.inspect('/');
  assert.equal(elementSourceHintCacheStats().parses, parses);
  const beforeRefresh = inspector.stats();
  inspector.invalidate();
  await inspector.inspect('/');
  // Work counters, not wall time: an unchanged refresh reloads and rereads nothing.
  assert.equal(inspector.stats().reloads, beforeRefresh.reloads, 'unchanged refresh reuses the imported export');
  assert.equal(inspector.stats().sourceFiles.misses, beforeRefresh.sourceFiles.misses);
  assert.equal(elementSourceHintCacheStats().parses, parses);
  fs.appendFileSync(path.join(fx.portal, 'web-templates/S590.webtemplate.source.html'), '<b id="changed590"></b>');
  inspector.invalidate();
  const changed = await inspector.inspect('/');
  assert.equal(elementSourceHintCacheStats().parses, parses + 1);
  assert.ok(changed.report.elementSources.some((item) => item.selector === '#changed590'));
});

test('whole-export form inventory preserves dynamic FormXml and native quick-view identity through source refresh', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  fs.writeFileSync(
    path.join(fx.portal, 'basic-forms/Dynamic.basicform.yml'),
    'adx_entityformid: dynamic\nadx_name: Dynamic form\nadx_entityname: fx_widget\nadx_formname: Widget form',
  );
  const inspector = createSourceInspector({ sourceDir: fx.portal, mirageConfig: { project: fx.project } });
  const first = (await inspector.inspect('/other/')).report;
  const form = first.componentIndex.forms.find((row) => row.id === 'dynamic');
  assert.ok(form, 'unreferenced basic forms are available without an opener include');
  assert.equal(form.formXml?.id, 'widget-form');
  assert.match(form.formXml?.sourceFile ?? '', /widget-form.xml$/);
  const system = first.componentIndex.forms.find((row) => row.id === 'widget-form');
  assert.equal(system?.entity, 'fx_widget');
  assert.equal(system?.kind, 'FormXml');
  fs.writeFileSync(
    path.join(fx.portal, 'basic-forms/Dynamic.basicform.yml'),
    'adx_entityformid: dynamic\nadx_name: Renamed dynamic\nadx_entityname: fx_widget\nadx_formname: Widget form',
  );
  inspector.invalidate();
  const refreshed = (await inspector.inspect('/other/')).report;
  assert.equal(refreshed.componentIndex.forms.find((row) => row.id === 'dynamic').name, 'Renamed dynamic');
});

test('conflicting rendered frame definitions never acquire a source verdict from an otherwise matching field', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  const inspector = createSourceInspector({ sourceDir: fx.portal, mirageConfig: { project: fx.project } });
  const { report } = await inspector.inspect('/', {
    controls: [{ id: 'fx_title', entity: 'fx_widget', formId: 'widget-edit', definitionConflict: true }],
  });
  const control = report.renderedControls[0];
  assert.equal(control.evidence, 'rendered-conflict');
  assert.equal(control.field, null);
  assert.equal(control.sourceFile, null);
  assert.deepEqual(control.candidates, []);
});

test('rendered basic-form and system-form alias candidates resolve only through a unique verified export link', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  const inspector = createSourceInspector({ sourceDir: fx.portal, mirageConfig: { project: fx.project } });
  const control = {
    id: 'fx_title',
    entity: 'FX_WIDGET',
    formId: '',
    definitionConflict: true,
    definitionAliasCandidates: ['widget-edit', 'widget-form'],
  };
  const resolved = (await inspector.inspect('/other/', { controls: [control] })).report;
  assert.equal(resolved.renderedControls[0].definitionConflict, false);
  assert.equal(resolved.renderedControls[0].formId, 'widget-edit');
  assert.ok(resolved.forms.some((form) => form.id === 'widget-edit'));
  for (const overrides of [
    { definitionAliasCandidates: ['widget-edit', 'missing'] },
    { formId: 'conflicting-form' },
    { entity: 'other' },
  ]) {
    const report = (await inspector.inspect('/other/', { controls: [{ ...control, ...overrides }] })).report;
    assert.equal(report.renderedControls[0].evidence, 'rendered-conflict');
    assert.equal(report.renderedControls[0].field, null);
  }
});
