// Declared inspection budgets: rendered candidates, script notes and
// oversized markup are bounded and reported, never silently attributed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSourceInspector } from '../lense/source-inspection.mjs';
import { inspectionFixture } from './source-inspection-fixture.mjs';

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
