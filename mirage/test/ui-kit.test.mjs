// @test-kind contract: Paqvilo's own simulator administration, CLI, configuration and runtime behaviour
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml,
  badge,
  statusBadge,
  levelBadge,
  pageItems,
  tableTools,
  table,
  section,
  help,
  fieldHelp,
  guide,
  kv,
  tiles,
  notice,
  docLink,
  leadHelp,
  splitLead,
  sortable,
  sortItems,
} from '../admin/ui-kit.mjs';

const items = Array.from({ length: 23 }, (_, index) => ({
  id: index + 1,
  name: `Invented ${index + 1}`,
  tag: index % 2 ? 'Odd' : 'Even',
}));

test('escapeHtml escapes the admin table and every builder escapes values', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
  for (const html of [
    badge('<b>'),
    notice('<b>'),
    fieldHelp('a"b', '<b>'),
    help({ text: '<b>' }),
    tiles([{ label: '<b>', value: '<i>' }]),
    guide({ key: 'k', intro: '<b>', steps: ['<i>'], example: '<s>' }),
  ])
    assert.doesNotMatch(html, /<b>|<i>|<s>/);
  assert.match(badge('x', 'nope'), /ui-tone-neutral/);
  assert.match(statusBadge('missing'), /ui-tone-bad">missing</);
  assert.match(statusBadge('weird<'), /ui-tone-neutral">weird&lt;</);
  assert.match(levelBadge('behaviour'), /ui-tone-ok">behaviour</);
});

test('pageItems pages, searches case-insensitively over text(item) and clamps the page', () => {
  const first = pageItems(items, { page: 1, size: 10 });
  assert.deepEqual([first.total, first.pages, first.page, first.items.length, first.items[0].id], [23, 3, 1, 10, 1]);
  assert.deepEqual(
    pageItems(items, { page: 3, size: 10 }).items.map((item) => item.id),
    [21, 22, 23],
  );
  assert.equal(pageItems(items, { page: 99, size: 10 }).page, 3);
  assert.equal(pageItems(items, { page: -4, size: 10 }).page, 1);
  assert.equal(pageItems(items, {}).size, 10);
  const odd = pageItems(items, { search: '  oDD ', size: 50 }, { text: (item) => item.tag });
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
  const columns = [{ label: 'Name', render: (item) => escapeHtml(item.name), className: 'wide' }];
  const html = table({
    key: 'x-items',
    columns,
    result: pageItems(items, { size: 10 }),
    caption: 'Items',
    rowAttrs: (item) => ({ 'data-id': item.id, onclick: 'bad()', class: 'r' }),
  });
  assert.match(html, /<table class="ui-table" data-table="x-items"><caption class="ui-sr-only">Items<\/caption>/);
  assert.equal(html.match(/<tr data-id=/g).length, 10);
  assert.doesNotMatch(html, /onclick/);
  assert.match(html, /<th scope="col" class="wide">Name<\/th>/);
  const empty = table({ key: 'x-items', columns, result: pageItems([], {}), emptyText: 'Nothing <here>' });
  assert.match(empty, /data-table-empty="x-items">Nothing &lt;here&gt;</);
  assert.doesNotMatch(empty, /<table/);
  assert.match(
    table({ key: 'x-items', columns, result: pageItems(items, { search: 'zzz' }) }),
    /No results match “zzz”/,
  );
});

test('section is collapsed by default and opens on request', () => {
  const closed = section({
    key: 'storage',
    title: 'Storage',
    summary: '2 routes',
    body: '<p>x</p>',
    help: { id: 'storage-help', text: 'About storage' },
  });
  assert.match(
    closed,
    /^<details class="ui-section" data-ui-section="storage"><summary><span class="ui-section-title">Storage<\/span><span class="ui-section-summary">2 routes<\/span><\/summary><div class="ui-section-body"><p class="ui-help" id="storage-help">About storage<\/p><p>x<\/p><\/div><\/details>$/,
  );
  assert.match(section({ key: 's', title: 'T', open: true, body: () => 'lazy' }), /data-ui-section="s" open>.*lazy/);
});

test('help, fieldHelp and guide render their documented markup', () => {
  assert.equal(
    fieldHelp('dv-port', 'Port to listen on'),
    '<span class="ui-info ui-field-info"><button type="button" class="ui-info-button" aria-label="About this field" aria-describedby="dv-port-help">i</button><span class="ui-info-pop ui-field-help" role="tooltip" id="dv-port-help">Port to listen on</span></span>',
  );
  const doc = { href: 'https://example.test/blob/main/mirage/docs/x.md', label: 'X', path: 'mirage/docs/x.md' };
  assert.match(
    help({ id: 'h', text: 'Read', doc }),
    /<p class="ui-help" id="h">Read <a class="ui-doc" href="https:\/\/example.test\/blob\/main\/mirage\/docs\/x.md" target="_blank" rel="noreferrer">X<\/a> <code>mirage\/docs\/x.md<\/code><\/p>/,
  );
  assert.equal(
    help({ text: 'Read', doc: { href: null, label: 'X', path: 'a.md' } }),
    '<p class="ui-help">Read <code>a.md</code></p>',
  );
  const html = guide({ key: 'packs', intro: 'Intro text', steps: ['one', 'two'], example: 'code', docs: [doc] });
  assert.match(
    html,
    /^<section class="ui-guide" data-ui-guide="packs"><p class="ui-guide-intro">Intro text<\/p><details class="ui-guide-more" data-ui-section="guide:packs"><summary>How this works<\/summary><ol><li>one<\/li><li>two<\/li><\/ol><pre class="ui-example">code<\/pre>/,
  );
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.doesNotMatch(guide({ key: 'k', intro: 'only' }), /<details/);
});

test('kv renders a definition list and tiles carry their tone', () => {
  assert.equal(
    kv([['Port', '<code>1</code>', { mono: true }]]),
    '<dl class="ui-kv"><div class="ui-kv-row"><dt>Port</dt><dd class="ui-mono"><code>1</code></dd></div></dl>',
  );
  assert.match(
    tiles([{ label: 'Requests', value: 3, detail: 'd', tone: 'ok' }]),
    /ui-tile ui-tone-ok.*Requests.*>3<.*d</,
  );
});

test('docLink resolves against the docs map and falls back to a path-only link', () => {
  const docs = {
    packs: {
      href: 'https://example.test/blob/v1.2.3/mirage/docs/data-packs.md',
      path: 'mirage/docs/data-packs.md',
      label: 'Data Packs',
    },
  };
  assert.deepEqual(docLink('mirage/docs/data-packs.md#recognised-exports', docs), {
    href: 'https://example.test/blob/v1.2.3/mirage/docs/data-packs.md#recognised-exports',
    label: 'Data Packs',
    path: 'mirage/docs/data-packs.md#recognised-exports',
  });
  assert.deepEqual(docLink('mirage/docs/service-fixtures.md', docs), {
    href: null,
    label: 'Service Fixtures',
    path: 'mirage/docs/service-fixtures.md',
  });
  assert.equal(docLink('docs/setup.md', undefined).href, null);
});

test('leadHelp keeps the first sentence visible and the rest, steps and doc behind an (i) tooltip', () => {
  assert.deepEqual(splitLead('Plain words first. Details (with codes) after. More.'), [
    'Plain words first.',
    'Details (with codes) after. More.',
  ]);
  assert.deepEqual(splitLead('One sentence only, for example cloud-flow:*.'), [
    'One sentence only, for example cloud-flow:*.',
    '',
  ]);
  const doc = { href: 'https://example.test/x.md', label: 'X', path: 'x.md' };
  const html = leadHelp({
    id: 'help-x',
    label: 'Storage',
    text: 'Where bytes go. Details <b>here</b>.',
    steps: ['one'],
    doc,
  });
  assert.match(
    html,
    /^<p class="ui-help" id="help-x">Where bytes go\.<span class="ui-info"><button type="button" class="ui-info-button" aria-label="About Storage" aria-describedby="help-x-more">i<\/button><span class="ui-info-pop" role="tooltip" id="help-x-more"><span class="ui-info-text">Details &lt;b&gt;here&lt;\/b&gt;\.<\/span><span class="ui-info-step">1\. one<\/span><span class="ui-info-docs"><a class="ui-doc" href="https:\/\/example.test\/x.md"/,
  );
  assert.equal(leadHelp({ text: 'Only this.' }), '<p class="ui-help">Only this.</p>');
  assert.equal(leadHelp({ text: '' }), '');
  // A view guide shows its lead; the details paragraph opens with How this works.
  assert.match(
    guide({ key: 'g', intro: 'Lead.', details: 'More text.' }),
    /<p class="ui-guide-intro">Lead\.<\/p><details class="ui-guide-more" data-ui-section="guide:g"><summary>How this works<\/summary><p class="ui-guide-details">More text\.<\/p><\/details>/,
  );
  // A column may explain its values behind an (i) in its header.
  assert.match(
    table({
      key: 't',
      items: [{ a: 1 }],
      columns: [{ label: 'Level', info: 'What <levels> mean', render: (item) => item.a }],
    }),
    /<th scope="col">Level<span class="ui-info"><button type="button" class="ui-info-button" aria-label="About Level">i<\/button><span class="ui-info-pop" role="tooltip"><span class="ui-info-text">What &lt;levels&gt; mean<\/span><\/span><\/span><\/th>/,
  );
});

// DV-N4c-1: every data column of a client-side table sorts by the text it shows; row actions never sort.
test('sortable gives each data column a sort key by its shown text, numbers in numeric order', () => {
  const columns = sortable([
    { label: 'Name', render: (item) => `<code>${escapeHtml(item.name)}</code>` },
    { label: 'Count', render: (item) => `${item.count} runs` },
    { label: 'Own', sortKey: 'own', render: () => '' },
    { label: 'Inspect', sortKey: false, render: () => '<button>Inspect</button>' },
    { label: 'Actions', render: () => '<button>Edit</button>' },
    { label: 'More', className: 'ui-actions', render: () => '<button>Open</button>' },
  ]);
  assert.deepEqual(
    columns.map((column) => column.sortKey ?? null),
    ['col-0', 'col-1', 'own', false, null, null],
  );
  const rows = [
    { name: 'b & c', count: 10 },
    { name: 'a', count: 9 },
  ];
  assert.deepEqual(
    sortItems(rows, columns, { key: 'col-0', order: 'asc' }).map((row) => row.name),
    ['a', 'b & c'],
  );
  assert.deepEqual(
    sortItems(rows, columns, { key: 'col-1', order: 'desc' }).map((row) => row.count),
    [10, 9],
  );
});

// D-M-11: every shared table has the bottom bar (count, rows per page, Previous/Next) and, with more than one sortable
// column, Filters with a drawer of column filters; filterItems keeps the rows whose column holds the text.
test('dataTable: the bottom bar on one page, Filters for column filters, filterItems by column', async () => {
  const kit = await import('../admin/ui-kit.mjs');
  const columns = kit.sortable([
    { label: 'Name', render: (item) => escapeHtml(item.name) },
    { label: 'Tag', render: (item) => escapeHtml(item.tag) },
  ]);
  const html = kit.dataTable({
    id: 'fx table',
    caption: 'Invented',
    columns,
    result: kit.pageItems(items.slice(0, 2), {}),
    search: true,
    filters: { 'col-1': 'Odd' },
  });
  assert.match(
    html,
    /<span class="ui-table-count">2 results<\/span><label class="ui-table-size">Rows <select data-table-size="fx table"/,
  );
  assert.match(html, /data-table-page="fx table" data-delta="-1" disabled>Previous<\/button>/);
  assert.match(html, /data-table-page="fx table" data-delta="1" disabled>Next<\/button>/);
  assert.match(html, /data-filter-toggle="fx-table-filters"[^>]*>Filters · 1<\/button>/);
  assert.match(html, /<aside class="ui-filter-drawer" id="fx-table-filters"/);
  assert.match(html, /<input id="fx-table-filters-1" type="search" name="col-1" value="Odd"/);
  assert.match(html, /aria-label="Remove filter Tag: Odd" data-table-unfilter="fx table" data-filter-key="col-1"/);
  assert.deepEqual(
    kit.filterItems(items, columns, { 'col-1': 'odd', 'col-0': 'invented 1' }).map((item) => item.id),
    [10, 12, 14, 16, 18],
  );
  // One sortable column: no Filters; the page's main list (bar: false) keeps chips and drawer, not the bar.
  assert.doesNotMatch(kit.dataTable({ id: 'one', columns: columns.slice(0, 1), items: [], filters: {} }), /Filters/);
  assert.doesNotMatch(
    kit.dataTable({ id: 'main', columns, items: [], search: true, filters: {}, bar: false }),
    /ui-table-bar/,
  );
});
