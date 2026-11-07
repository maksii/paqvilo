// Source hints of the current export outlive the global hint LRU and the
// per-inspector report cache. Parse counts are process-global, so this
// scenario has its own file (and process).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSourceInspector } from '../lense/source-inspection.mjs';
import { elementSourceHintCacheStats } from '../lense/element-provenance.mjs';
import { inspectionFixture } from './source-inspection-fixture.mjs';

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
