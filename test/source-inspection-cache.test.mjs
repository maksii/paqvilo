import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createSourceInspector } from '../lense/source-inspection.mjs';
import { elementSourceHintCacheStats } from '../lense/element-provenance.mjs';
import { inspectionFixture } from './source-inspection-fixture.mjs';

test('X-ray report size follows page candidates, revisits reuse reports, and refresh parses only changed markup', async (t) => {
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

test('rendered shape selects unreferenced snippet candidates and declares the extra-candidate budget', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  fs.writeFileSync(
    path.join(fx.portal, 'contentsnippet.yml'),
    JSON.stringify(
      Array.from({ length: 1250 }, (_, index) => ({
        adx_contentsnippetid: 'dynamic-' + index,
        adx_name: 'Dynamic ' + index,
        adx_value: '<aside class="dynamic-banner"></aside>',
      })),
    ),
  );
  const inspector = createSourceInspector({ sourceDir: fx.portal });
  const { report } = await inspector.inspect('/', { markupTokens: ['class:aside:dynamic-banner'] });
  assert.equal(report.elementSources.filter((row) => row.selector === 'aside.dynamic-banner').length, 1200);
  assert.equal(
    report.elementSourceFrequencies['aside.dynamic-banner'],
    1250,
    'rarity retains the complete export evidence',
  );
  assert.equal(report.elementSourceLimits.candidateTruncated, true);
  assert.equal(report.elementSourceLimits.truncated, true);
});

test('truncated script notes use the same root-relative display path as their source row', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  fs.writeFileSync(
    path.join(fx.portal, 'web-files/widget.js'),
    Array.from({ length: 200 }, (_, index) => `document.querySelector('#id${index}');`).join('\n'),
  );
  const { report } = await createSourceInspector({ sourceDir: fx.portal }).inspect('/');
  const row = report.elementSources.find((item) => item.kind === 'script' && item.sourceFile.endsWith('widget.js'));
  assert.ok(row);
  assert.deepEqual(report.elementSourceLimits.scriptTruncatedSources, [
    path.relative(fx.portal, row.sourceFile).replaceAll('\\', '/'),
  ]);
  assert.equal(
    report.elementSourceLimits.scriptTruncatedSources.some((value) => /[\\:]|^\//.test(value)),
    false,
  );
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

test('current-export hints survive global LRU and route eviction; changed, renamed and removed sources retain identity', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  const rows = Array.from({ length: 4200 }, (_, index) => ({
    adx_webtemplateid: 'beyond-cache-' + index,
    adx_name: 'Beyond cache ' + index,
    adx_source: `<aside id="beyond-${index}"></aside>`,
  }));
  const file = path.join(fx.portal, 'webtemplate.yml');
  fs.writeFileSync(file, JSON.stringify(rows));
  fs.appendFileSync(
    path.join(fx.portal, 'web-pages/home/Home.webpage.copy.html'),
    "{% include 'Beyond cache 0' %}{% include 'Beyond cache 4199' %}",
  );
  const inspector = createSourceInspector({ sourceDir: fx.portal });
  await inspector.inspect('/');
  const firstParses = elementSourceHintCacheStats().parses;
  for (let index = 0; index < 18; index++) await inspector.inspect('/unresolved-route-' + index);
  const revisited = await inspector.inspect('/');
  assert.ok(revisited.report.elementSources.some((row) => row.selector === '#beyond-0'));
  assert.equal(
    elementSourceHintCacheStats().parses,
    firstParses,
    'an evicted report reuses already indexed source hints',
  );
  assert.ok(inspector.stats().reports <= 16);
  assert.ok(inspector.stats().reportBytes <= 32 * 1024 * 1024);
  assert.ok(elementSourceHintCacheStats().entries <= 4096, 'the global source cache bound is retained');
  rows[4199].adx_source += '<b id="changed-beyond-cache"></b>';
  fs.writeFileSync(file, JSON.stringify(rows));
  inspector.invalidate();
  const changed = await inspector.inspect('/');
  assert.ok(changed.report.elementSources.some((row) => row.selector === '#changed-beyond-cache'));
  assert.equal(
    elementSourceHintCacheStats().parses,
    firstParses + 1,
    'one changed body above the LRU capacity causes one parse',
  );
  rows[4199].adx_name = 'Renamed beyond cache';
  fs.writeFileSync(file, JSON.stringify(rows));
  inspector.invalidate();
  const renamed = (await inspector.inspect('/', { markupTokens: ['id:changed-beyond-cache'] })).report;
  assert.equal(
    renamed.elementSources.find((row) => row.selector === '#changed-beyond-cache').name,
    'Renamed beyond cache',
  );
  assert.equal(
    elementSourceHintCacheStats().parses,
    firstParses + 1,
    'source name updates rebind cached hints without parsing markup',
  );
  const indexed = inspector.stats().indexedSources;
  rows.pop();
  fs.writeFileSync(file, JSON.stringify(rows));
  inspector.invalidate();
  const removed = (await inspector.inspect('/', { markupTokens: ['id:changed-beyond-cache'] })).report;
  assert.equal(
    removed.elementSources.some((row) => row.selector === '#changed-beyond-cache'),
    false,
  );
  assert.equal(inspector.stats().indexedSources, indexed - 1, 'deleted sources leave the current export index');
  assert.equal(elementSourceHintCacheStats().parses, firstParses + 1);
  fs.appendFileSync(path.join(fx.portal, 'website.yml'), '\nadx_defaultlanguage: lang-en');
  fs.writeFileSync(
    path.join(fx.portal, 'websitelanguage.yml'),
    '- adx_websitelanguageid: lang-en\n  adx_name: English\n  adx_languagecode: en-US\n  adx_lcid: 1033\n- adx_websitelanguageid: lang-fr\n  adx_name: French\n  adx_languagecode: fr-FR\n  adx_lcid: 1036',
  );
  for (const [code, id] of [
    ['en-US', 'en'],
    ['fr-FR', 'fr'],
  ]) {
    const prefix = path.join(fx.portal, 'web-pages/home/Home.' + code + '.webpage');
    fs.writeFileSync(
      prefix + '.yml',
      `adx_webpageid: home-${id}\nadx_rootwebpageid: home\nadx_isroot: false\nadx_name: ${id} page\nadx_webpagelanguageid: lang-${id}\nadx_partialurl: /\nadx_pagetemplateid: main`,
    );
    fs.writeFileSync(prefix + '.copy.html', `<main id="${id}-page"></main>`);
  }
  inspector.invalidate();
  await inspector.inspect('/en-US/');
  const beforeFrench = elementSourceHintCacheStats().parses;
  const french = (await inspector.inspect('/fr-FR/')).report;
  assert.equal(
    elementSourceHintCacheStats().parses,
    beforeFrench + 1,
    'a new language parses its own page, reusing unchanged shared templates beyond global LRU capacity',
  );
  assert.equal(french.language.code, 'fr-FR');
  assert.equal(french.page.title, 'fr page');
  fs.writeFileSync(
    path.join(fx.portal, 'websitelanguage.yml'),
    '- adx_websitelanguageid: lang-en\n  adx_name: English\n  adx_languagecode: en-US\n  adx_lcid: 1033',
  );
  inspector.invalidate();
  await inspector.inspect('/en-US/');
  assert.equal(
    inspector.stats().indexedLanguages,
    1,
    'removed language indexes and the earlier default-less index are discarded',
  );
});

test('direct rendered IDs precede broad class buckets when the additional candidate budget is reached', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  const rows = Array.from({ length: 1250 }, (_, index) => ({
    adx_contentsnippetid: 'crowded-' + index,
    adx_name: 'Crowded ' + index,
    adx_value: '<b class="crowded"></b>',
  }));
  rows.push({
    adx_contentsnippetid: 'exact',
    adx_name: 'Exact identity',
    adx_value: '<aside id="rare-exact"></aside>',
  });
  fs.writeFileSync(path.join(fx.portal, 'contentsnippet.yml'), JSON.stringify(rows));
  const report = (
    await createSourceInspector({ sourceDir: fx.portal }).inspect('/', {
      markupTokens: ['class:b:crowded', 'id:rare-exact'],
    })
  ).report;
  assert.ok(report.elementSources.some((row) => row.selector === '#rare-exact'));
  assert.equal(report.elementSourceLimits.candidateTruncated, true);
  assert.equal(report.elementSources.filter((row) => row.name?.startsWith('Crowded ')).length, 1199);
});

test('oversized referenced and unreferenced markup marks the export index incomplete without source attribution', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  const oversized = '<aside id="oversize-visible">PRIVATE_BODY_SENTINEL</aside>' + ' '.repeat(1024 * 1024);
  fs.writeFileSync(
    path.join(fx.portal, 'content-snippets/Oversize.contentsnippet.yml'),
    'adx_contentsnippetid: oversize\nadx_name: Oversize',
  );
  fs.writeFileSync(path.join(fx.portal, 'content-snippets/Oversize.contentsnippet.value.html'), oversized);
  const inspector = createSourceInspector({ sourceDir: fx.portal });
  const first = (await inspector.inspect('/', { markupTokens: ['id:oversize-visible'] })).report;
  assert.equal(
    first.snippets.some((row) => row.name === 'Oversize'),
    false,
    'the source is not in the page include graph',
  );
  assert.equal(
    first.elementSources.some((row) => row.name === 'Oversize'),
    false,
    'oversized source cannot be attributed from an unparsed body',
  );
  assert.equal(first.elementSourceLimits.markupIndexComplete, false);
  assert.equal(first.elementSourceLimits.markupOmittedSourceCount, 1);
  assert.deepEqual(first.elementSourceLimits.markupOmittedSources, [
    'content-snippets/Oversize.contentsnippet.value.html',
  ]);
  assert.equal(first.elementSourceLimits.truncated, true);
  assert.equal(first.elementSourceLimits.markupOmittedSourcesTruncated, false);
  assert.doesNotMatch(JSON.stringify(first.elementSourceLimits), /PRIVATE_BODY_SENTINEL|[A-Za-z]:\\/);
  fs.appendFileSync(path.join(fx.portal, 'web-pages/home/Home.webpage.copy.html'), '{{ snippets["Oversize"] }}');
  inspector.invalidate();
  const referenced = (await inspector.inspect('/')).report;
  assert.ok(referenced.snippets.some((row) => row.name === 'Oversize'));
  assert.equal(
    referenced.elementSourceLimits.markupOmittedSourceCount,
    1,
    'referencing a source does not double count its omission',
  );
  assert.equal(
    referenced.elementSources.some((row) => row.selector === '#oversize-visible'),
    false,
  );
  assert.equal(referenced.elementSourceLimits.truncated, true);
});

test('export-wide omission summary counts all skipped sources but bounds display names and preserves the source-size boundary', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  const prefix = '<aside id="at-limit"></aside>',
    atLimit = prefix + ' '.repeat(1024 * 1024 - prefix.length);
  const tooLarge = atLimit + ' ';
  fs.writeFileSync(
    path.join(fx.portal, 'contentsnippet.yml'),
    JSON.stringify([
      { adx_contentsnippetid: 'at-limit', adx_name: 'At limit', adx_value: atLimit },
      ...Array.from({ length: 12 }, (_, index) => ({
        adx_contentsnippetid: 'omitted-' + index,
        adx_name: 'Omitted ' + index,
        adx_value: tooLarge,
        private: 'PRIVATE_PROPERTY_SENTINEL',
      })),
    ]),
  );
  const { report } = await createSourceInspector({ sourceDir: fx.portal }).inspect('/', {
    markupTokens: ['id:at-limit'],
  });
  const limits = report.elementSourceLimits;
  assert.equal(limits.markupOmittedSourceCount, 12);
  assert.equal(limits.markupOmittedSources.length, 10);
  assert.equal(limits.markupOmittedSourceNameLimit, 10);
  assert.equal(limits.markupOmittedSourcesTruncated, true);
  assert.ok(limits.markupOmittedSources.every((name) => name.length <= 240 && !/[\\:]|^\//.test(name)));
  assert.doesNotMatch(JSON.stringify(limits), /PRIVATE_PROPERTY_SENTINEL|at-limit/);
  assert.ok(
    report.elementSources.some((row) => row.name === 'At limit'),
    'exactly 1MiB of UTF-16 code units is eligible',
  );
  assert.equal(
    report.elementSources.some((row) => row.name?.startsWith('Omitted')),
    false,
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

test('list source links select definition metadata and script truncation is exposed in inspection metadata', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  fs.mkdirSync(path.join(fx.portal, 'lists'));
  const definition = path.join(fx.portal, 'lists/Items.list.yml'),
    script = path.join(fx.portal, 'lists/Items.list.custom_javascript.js');
  fs.writeFileSync(definition, 'adx_entitylistid: items\nadx_name: Items\nadx_entityname: fx_widget');
  fs.writeFileSync(script, 'window.listFeature=true;');
  fs.appendFileSync(path.join(fx.portal, 'web-pages/home/Home.webpage.copy.html'), '{% entitylist name: "Items" %}');
  fs.writeFileSync(
    path.join(fx.portal, 'web-pages/home/Home.webpage.custom_javascript.js'),
    Array.from({ length: 121 }, (_, index) => `$("#item${index}");`).join('\n'),
  );
  const { report } = await createSourceInspector({ sourceDir: fx.portal }).inspect('/'),
    list = report.components.find((row) => row.kind === 'list');
  assert.equal(list.sourceFile, definition);
  assert.equal(list.customization.sourceFile, script);
  assert.equal(report.elementSourceLimits.scriptTruncated, true);
  assert.equal(report.elementSourceLimits.truncated, true);
  assert.deepEqual(report.elementSourceLimits.scriptTruncatedSources, [
    'web-pages/home/Home.webpage.custom_javascript.js',
  ]);
});

test('600 source reports survive A/B/A and unchanged refresh without reparsing markup', async (t) => {
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
  const inspector = createSourceInspector({ sourceDir: fx.portal }),
    start = performance.now();
  const first = await inspector.inspect('/'),
    built = performance.now() - start,
    parses = elementSourceHintCacheStats().parses;
  await inspector.inspect('/other/');
  first.report.pageSources.length = 0;
  const again = await inspector.inspect('/');
  assert.ok(again.report.pageSources.length > 0, 'cached reports are independent');
  assert.equal(elementSourceHintCacheStats().parses, parses);
  inspector.invalidate();
  await inspector.inspect('/');
  assert.equal(elementSourceHintCacheStats().parses, parses);
  inspector.invalidate();
  const refresh = performance.now();
  await inspector.inspect('/');
  assert.ok(
    performance.now() - refresh < Math.max(built * 2, 1000),
    'unchanged refresh remains comparable to its first build',
  );
  assert.equal(elementSourceHintCacheStats().parses, parses);
  fs.appendFileSync(path.join(fx.portal, 'web-templates/S590.webtemplate.source.html'), '<b id="changed590"></b>');
  inspector.invalidate();
  const changed = await inspector.inspect('/');
  assert.equal(elementSourceHintCacheStats().parses, parses + 1);
  assert.ok(changed.report.elementSources.some((item) => item.selector === '#changed590'));
});
