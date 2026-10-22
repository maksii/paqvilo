import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, badge, statusBadge, levelBadge, pageItems, tableTools, table, section, help, fieldHelp, guide, kv, tiles, notice, docLink } from '../admin/ui-kit.mjs';

const items = Array.from({ length: 23 }, (_, index) => ({ id: index + 1, name: `Invented ${index + 1}`, tag: index % 2 ? 'Odd' : 'Even' }));

test('escapeHtml escapes the admin table and every builder escapes values', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
  for (const html of [badge('<b>'), notice('<b>'), fieldHelp('a"b', '<b>'), help({ text: '<b>' }), tiles([{ label: '<b>', value: '<i>' }]), guide({ key: 'k', intro: '<b>', steps: ['<i>'], example: '<s>' })])
    assert.doesNotMatch(html, /<b>|<i>|<s>/);
  assert.match(badge('x', 'nope'), /ui-tone-neutral/);
  assert.match(statusBadge('missing'), /ui-tone-bad">missing</);
  assert.match(statusBadge('weird<'), /ui-tone-neutral">weird&lt;</);
  assert.match(levelBadge('behaviour'), /ui-tone-ok">behaviour</);
});

test('pageItems pages, searches case-insensitively over text(item) and clamps the page', () => {
  const first = pageItems(items, { page: 1, size: 10 });
  assert.deepEqual([first.total, first.pages, first.page, first.items.length, first.items[0].id], [23, 3, 1, 10, 1]);
  assert.deepEqual(pageItems(items, { page: 3, size: 10 }).items.map(item => item.id), [21, 22, 23]);
  assert.equal(pageItems(items, { page: 99, size: 10 }).page, 3);
  assert.equal(pageItems(items, { page: -4, size: 10 }).page, 1);
  assert.equal(pageItems(items, {}).size, 10);
  const odd = pageItems(items, { search: '  oDD ', size: 50 }, { text: item => item.tag });
  assert.deepEqual([odd.total, odd.search], [11, 'oDD']);
  assert.equal(pageItems(items, { search: 'Even' }, { searchable: false }).total, 23);
  assert.deepEqual(pageItems([], { page: 5 }), { items: [], total: 0, pages: 1, page: 1, size: 10, search: '' });
});

test('tableTools emits the admin attributes, labels and result text', () => {
  const html = tableTools('mappings', pageItems(items, { page: 1, size: 20 }));
  assert.match(html, /<input type="search" data-table-search="mappings" aria-label="Search mappings"/);
  assert.match(html, /<select data-table-size="mappings" aria-label="Rows per page for mappings">/);
  assert.match(html, /<option value="20" selected>20<\/option>/);
  assert.match(html, /data-table-page="mappings" data-delta="-1" disabled>Previous</);
  assert.match(html, /data-table-page="mappings" data-delta="1">Next</);
  assert.match(html, /23 results · Page 1 of 2/);
  assert.doesNotMatch(tableTools('audit', pageItems(items, {}), { searchable: false }), /data-table-search/);
});

test('table renders data-table, caption, safe row attributes and an empty state', () => {
  const columns = [{ label: 'Name', render: item => escapeHtml(item.name), className: 'wide' }];
  const html = table({ key: 'x-items', columns, result: pageItems(items, { size: 10 }), caption: 'Items', rowAttrs: item => ({ 'data-id': item.id, onclick: 'bad()', class: 'r' }) });
  assert.match(html, /<table class="ui-table" data-table="x-items"><caption class="ui-sr-only">Items<\/caption>/);
  assert.equal(html.match(/<tr data-id=/g).length, 10);
  assert.doesNotMatch(html, /onclick/);
  assert.match(html, /<th scope="col" class="wide">Name<\/th>/);
  const empty = table({ key: 'x-items', columns, result: pageItems([], {}), emptyText: 'Nothing <here>' });
  assert.match(empty, /data-table-empty="x-items">Nothing &lt;here&gt;</);
  assert.doesNotMatch(empty, /<table/);
  assert.match(table({ key: 'x-items', columns, result: pageItems(items, { search: 'zzz' }) }), /No results match “zzz”/);
});

test('section is collapsed by default and opens on request', () => {
  const closed = section({ key: 'storage', title: 'Storage', summary: '2 routes', body: '<p>x</p>', help: { id: 'storage-help', text: 'About storage' } });
  assert.match(closed, /^<details class="ui-section" data-ui-section="storage"><summary><span class="ui-section-title">Storage<\/span><span class="ui-section-summary">2 routes<\/span><\/summary><div class="ui-section-body"><p class="ui-help" id="storage-help">About storage<\/p><p>x<\/p><\/div><\/details>$/);
  assert.match(section({ key: 's', title: 'T', open: true, body: () => 'lazy' }), /data-ui-section="s" open>.*lazy/);
});

test('help, fieldHelp and guide structure', () => {
  assert.equal(fieldHelp('dv-port', 'Port to listen on'), '<small class="ui-field-help" id="dv-port-help">Port to listen on</small>');
  const doc = { href: 'https://example.test/blob/main/mirage/docs/x.md', label: 'X', path: 'mirage/docs/x.md' };
  assert.match(help({ id: 'h', text: 'Read', doc }), /<p class="ui-help" id="h">Read <a class="ui-doc" href="https:\/\/example.test\/blob\/main\/mirage\/docs\/x.md" target="_blank" rel="noreferrer">X<\/a> <code>mirage\/docs\/x.md<\/code><\/p>/);
  assert.equal(help({ text: 'Read', doc: { href: null, label: 'X', path: 'a.md' } }), '<p class="ui-help">Read <code>a.md</code></p>');
  const html = guide({ key: 'packs', intro: 'Intro text', steps: ['one', 'two'], example: 'code', docs: [doc] });
  assert.match(html, /^<section class="ui-guide" data-ui-guide="packs"><p class="ui-guide-intro">Intro text<\/p><details class="ui-guide-more" data-ui-section="guide:packs"><summary>How this works<\/summary><ol><li>one<\/li><li>two<\/li><\/ol><pre class="ui-example">code<\/pre>/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.doesNotMatch(guide({ key: 'k', intro: 'only' }), /<details/);
});

test('kv and tiles', () => {
  assert.equal(kv([['Port', '<code>1</code>', { mono: true }]]), '<dl class="ui-kv"><div class="ui-kv-row"><dt>Port</dt><dd class="ui-mono"><code>1</code></dd></div></dl>');
  assert.match(tiles([{ label: 'Requests', value: 3, detail: 'd', tone: 'ok' }]), /ui-tile ui-tone-ok.*Requests.*>3<.*d</);
});

test('docLink resolves against the D9 map and falls back to a path-only link', () => {
  const docs = { packs: { href: 'https://example.test/blob/v1.2.3/mirage/docs/data-packs.md', path: 'mirage/docs/data-packs.md', label: 'Data Packs' } };
  assert.deepEqual(docLink('mirage/docs/data-packs.md#recognised-exports', docs), { href: 'https://example.test/blob/v1.2.3/mirage/docs/data-packs.md#recognised-exports', label: 'Data Packs', path: 'mirage/docs/data-packs.md#recognised-exports' });
  assert.deepEqual(docLink('mirage/docs/service-fixtures.md', docs), { href: null, label: 'Service Fixtures', path: 'mirage/docs/service-fixtures.md' });
  assert.equal(docLink('docs/setup.md', undefined).href, null);
});
