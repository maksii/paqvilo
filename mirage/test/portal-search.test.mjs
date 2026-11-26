// @test-kind contract: locally hosted portal search applies its documented query subset, authored search views and visitor permissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { organizationRecord } from '../lib/organization-context.mjs';
import { portalSearch } from '../lib/portal-search.mjs';
import { compilePortalSearchQuery } from '../lib/portal-search-query.mjs';
import { signInHeaders } from '../testing.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const SITE = '77777777-7777-4777-8777-777777777710';
const DETAILS = '77777777-7777-4777-8777-777777777711';
const entity = (name, columns) =>
  `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}"><EntitySetName>${name}s</EntitySetName><PrimaryIdAttribute>${name}id</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="${name}id"><Name>${name}id</Name><Type>primarykey</Type></attribute>${columns.map((column) => `<attribute PhysicalName="${column}"><Name>${column}</Name><Type>nvarchar</Type><displaynames><displayname description="${column}" languagecode="1033"/></displaynames></attribute>`).join('')}</attributes></entity></EntityInfo></Entity>`;
const view = (table, id, name, columns, filter = '') =>
  `<savedquery><savedqueryid>{${id}}</savedqueryid><querytype>0</querytype><isdefault>0</isdefault><LocalizedNames><LocalizedName description="${name}" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="${table}">${columns.map((column) => `<attribute name="${column}"/>`).join('')}${filter}</entity></fetch></fetchxml><layoutxml><grid><row>${columns.map((column) => `<cell name="${column}" width="100"/>`).join('')}</row></grid></layoutxml></savedquery>`;

async function searchSite(
  t,
  { settings = [['Search/EnableAdditionalEntities', 'true']], markers = true, moreItems = 0 } = {},
) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-search-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'portal/website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented search`,
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Details.webpage.yml': `adx_webpageid: ${DETAILS}\nadx_name: Details\nadx_partialurl: item\nadx_parentpageid: home\nadx_pagetemplateid: main`,
    'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html':
      '<main id=probe>{% searchindex query: request.params.q, filter: request.params.filter, logical_names: request.params.ln, page: request.params.page, page_size: request.params.ps %}<p id=n>{{ searchindex.approximate_total_hits }}</p>{% for r in searchindex.results %}<li data-n="{{ r.number }}" data-url="{{ r.url }}" data-ln="{{ r.logical_name }}" data-fragment="{% if r.fragment == nil %}none{% else %}present{% endif %}">{{ r.title }}|{{ r.fragment }}</li>{% endfor %}{% endsearchindex %}</main>',
    'portal/sitesetting.yml':
      settings
        .map(([name, value], index) => `- adx_sitesettingid: s${index}\n  adx_name: ${name}\n  adx_value: "${value}"`)
        .join('\n') || '[]',
    'portal/webrole.yml':
      '- adx_webroleid: member\n  adx_name: Member\n- adx_webroleid: anonymous\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true',
    ...(markers
      ? {
          'portal/sitemarker.yml': `- adx_sitemarkerid: m1\n  adx_name: x_item_SearchResultPage\n  adx_pageid: ${DETAILS}`,
        }
      : {}),
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedSearch</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/x_item/Entity.xml': entity('x_item', ['x_name', 'x_note', 'x_kind']),
    'solution/Entities/x_item/SavedQueries/search.xml': view(
      'x_item',
      '77777777-7777-4777-8777-777777777720',
      'Portal Search',
      ['x_name', 'x_note'],
      '<filter><condition attribute="x_kind" operator="ne" value="hidden"/></filter>',
    ),
    'solution/Entities/x_secret/Entity.xml': entity('x_secret', ['x_name']),
    'solution/Entities/x_secret/SavedQueries/search.xml': view(
      'x_secret',
      '77777777-7777-4777-8777-777777777721',
      'Portal Search',
      ['x_name'],
    ),
    'solution/Entities/x_plain/Entity.xml': entity('x_plain', ['x_name']),
    'solution/Entities/x_plain/SavedQueries/all.xml': view(
      'x_plain',
      '77777777-7777-4777-8777-777777777722',
      'All plains',
      ['x_name'],
    ),
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const id = (n) => `77777777-7777-4777-8777-7777777779${String(n).padStart(2, '0')}`;
  const initial = {
    version: 1,
    mappings: {
      x_item: { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name' },
      x_secret: { entitySet: 'x_secrets', idColumn: 'x_secretid', nameColumn: 'x_name' },
      x_plain: { entitySet: 'x_plains', idColumn: 'x_plainid', nameColumn: 'x_name' },
    },
    tables: {
      contact: [{ contactid: 'alex', fullname: 'Alex Local', statecode: 0 }],
      x_item: [
        { x_itemid: id(1), x_name: 'Invented lantern', x_note: 'bright lantern', x_kind: 'open' },
        { x_itemid: id(2), x_name: 'Invented anchor', x_note: 'heavy', x_kind: 'open' },
        { x_itemid: id(3), x_name: 'Invented lantern spare', x_note: 'kept', x_kind: 'hidden' },
        { x_itemid: id(4), x_name: 'Lanterns pack', x_note: 'many', x_kind: 'open' },
        ...Array.from({ length: moreItems }, (_, index) => ({
          x_itemid: id(index + 10),
          x_name: 'Paging fixture ' + String(index + 1).padStart(2, '0'),
          x_note: 'paging probe',
          x_kind: 'open',
        })),
      ],
      x_secret: [{ x_secretid: id(5), x_name: 'Invented lantern secret' }],
      x_plain: [{ x_plainid: id(6), x_name: 'Invented lantern plain' }],
    },
    permissions: [
      { id: 'items', entity: 'x_item', scope: 'global', roles: ['Anonymous Users', 'Member'], operations: ['read'] },
      { id: 'plain', entity: 'x_plain', scope: 'global', roles: ['Anonymous Users'], operations: ['read'] },
      { id: 'secret', entity: 'x_secret', scope: 'global', roles: ['Member'], operations: ['read'] },
    ],
    settings: { permissionMode: 'enforce' },
    simulator: {
      mode: 'local',
      pageMode: 'local',
      permissionSource: 'configured',
      live: { allowWrites: false },
      endpoints: [],
    },
  };
  const sim = await createSimulator({
    sourceDir: path.join(dir, 'portal'),
    solutionRoots: [path.join(dir, 'solution')],
    port: 0,
    watch: false,
    initial,
  });
  ownedFixture(t).add(() => sim.close());
  const page = async (query, headers = {}) => {
    const response = await fetch(`${sim.url}/?${new URLSearchParams(query)}`, { headers });
    const html = await response.text();
    assert.equal(response.status, 200, 'the Liquid search page returns results');
    const main = /<main id=probe>([\s\S]*?)<\/main>/.exec(html)[1];
    return {
      total: Number(/<p id=n>(\d*)<\/p>/.exec(main)[1]),
      items: [
        ...main.matchAll(
          /<li data-n="(\d+)" data-url="([^"]*)" data-ln="([^"]*)" data-fragment="([^"]*)">([^|]*)\|([\s\S]*?)<\/li>/g,
        ),
      ].map(([, n, url, ln, fragmentState, title, fragment]) => ({
        n: Number(n),
        url,
        ln,
        title,
        fragment: fragmentState === 'none' ? null : fragment,
      })),
    };
  };
  return { sim, page, id };
}

async function searchSiteWithDisabledIndex(t, siteSettings) {
  const fixture = await searchSite(t, { settings: [['Search/EnableAdditionalEntities', 'true'], ...siteSettings] });
  await fixture.sim.store.transact(() => {
    const organization = organizationRecord(fixture.sim.store);
    assert.ok(organization, 'the fixture has a configured organization row');
    organization.isexternalsearchindexenabled = false;
  });
  return fixture;
}

async function defaultSearchHtml(sim) {
  const response = await fetch(`${sim.url}/search/?q=lantern`);
  assert.equal(response.status, 200);
  return response.text();
}

test('searchindex returns permission-filtered results from the Portal Search views with site-marker urls', async (t) => {
  const { sim, page, id } = await searchSite(t);
  const anonymous = await page({ q: 'lantern' });
  // x_plain has no Portal Search view; x_secret is not readable anonymously; the view filter hides the spare.
  assert.deepEqual(
    anonymous.items.map((item) => [item.title, item.ln]),
    [['Invented lantern', 'x_item']],
  );
  assert.equal(anonymous.total, 1);
  assert.equal(anonymous.items[0].url, `/item/?id=${id(1)}`);
  assert.match(anonymous.items[0].fragment, /<em>lantern<\/em>/);
  const member = await page({ q: 'lantern' }, signInHeaders(sim, 'alex', { roles: ['Member'] }));
  assert.deepEqual(member.items.map((item) => item.title).sort(), ['Invented lantern', 'Invented lantern secret']);
  assert.equal(member.items.find((item) => item.ln === 'x_secret').url, '', 'no site marker: no url');
  // logical_names, prefix terms and paging.
  assert.deepEqual(
    (await page({ q: 'lantern', ln: 'x_secret' }, signInHeaders(sim, 'alex', { roles: ['Member'] }))).items.map(
      (item) => item.ln,
    ),
    ['x_secret'],
  );
  const prefixed = await page({ q: 'lantern*', ps: '1', page: '2' });
  assert.equal(prefixed.total, 2);
  assert.deepEqual(
    prefixed.items.map((item) => [item.n, item.title]),
    [[2, 'Lanterns pack']],
  );
});

test('additional tables need Search/EnableAdditionalEntities and Search/Enabled false returns nothing', async (t) => {
  const plain = await searchSite(t, { settings: [] });
  assert.equal((await plain.page({ q: 'lantern' })).total, 0);
  assert.match(JSON.stringify(plain.sim.state().diagnostics ?? []), /PORTAL_SEARCH_UNAVAILABLE/);
  const disabled = await searchSite(t, {
    settings: [
      ['Search/Enabled', 'false'],
      ['Search/EnableAdditionalEntities', 'true'],
    ],
  });
  assert.equal((await disabled.page({ q: 'lantern' })).total, 0);
  const diagnostics = JSON.stringify(disabled.sim.state().diagnostics ?? []);
  assert.match(diagnostics, /PORTAL_SEARCH_DISABLED/);
});

test('legacy portal search scans readable rows with the Dataverse index disabled', async (t) => {
  const { sim, page } = await searchSiteWithDisabledIndex(t, [['search/enableDataverseSearch', ' FALSE ']]);
  const result = await page({ q: 'lantern' });
  assert.equal(result.total, 1);
  assert.deepEqual(
    result.items.map((item) => item.title),
    ['Invented lantern'],
  );
  const html = await defaultSearchHtml(sim);
  assert.match(html, /role="status">1 result\(s\)<\/p>/);
  assert.match(html, />Invented lantern<\/a>/);
  assert.doesNotMatch(html, /x_secret|Invented lantern secret|Invented lantern spare/);
});

test('the organization index and site-wide switch still gate portal search', async (t) => {
  for (const [mode, siteSettings, diagnostic] of [
    ['omitted', [], 'PORTAL_SEARCH_UNAVAILABLE'],
    ['Dataverse', [['Search/EnableDataverseSearch', 'true']], 'PORTAL_SEARCH_UNAVAILABLE'],
    ['unknown', [['Search/EnableDataverseSearch', 'legacy']], 'PORTAL_SEARCH_UNAVAILABLE'],
    [
      'disabled legacy',
      [
        ['Search/EnableDataverseSearch', 'false'],
        ['Search/Enabled', 'false'],
      ],
      'PORTAL_SEARCH_DISABLED',
    ],
  ]) {
    await t.test(mode, async (check) => {
      const { sim, page } = await searchSiteWithDisabledIndex(check, siteSettings);
      assert.equal((await page({ q: 'lantern' })).total, 0);
      assert.doesNotMatch(await defaultSearchHtml(sim), /Invented lantern/);
      assert.ok(sim.state().diagnostics.some((entry) => entry.code === diagnostic));
    });
  }
});

test('legacy search availability applies only to the local portal and local data', async () => {
  for (const config of [
    { mode: 'live', pageMode: 'local' },
    { mode: 'local', pageMode: 'live' },
  ]) {
    const found = await portalSearch({
      portal: { settings: { 'Search/EnableDataverseSearch': 'false' } },
      store: { tables: { organization: [{ isexternalsearchindexenabled: false }] } },
      config,
    });
    assert.equal(found.unavailable, 'dataverse-search-off');
  }
});

test('portal search keeps phrases, operators, wildcard matching and term boosts distinct', async (t) => {
  const { page } = await searchSite(t);
  const titles = async (q) => (await page({ q })).items.map((item) => item.title);
  assert.deepEqual(await titles('"bright lantern"'), ['Invented lantern']);
  assert.deepEqual(await titles('"lantern bright"'), []);
  assert.deepEqual(await titles('"invented bright"'), [], 'a phrase cannot span two columns');
  assert.deepEqual(await titles('invented AND "bright lantern"'), ['Invented lantern']);
  assert.deepEqual(await titles('(anchor OR lantern) AND bright'), ['Invented lantern']);
  assert.deepEqual(await titles('invented NOT lantern'), ['Invented anchor']);
  assert.deepEqual(await titles('invented +anchor -heavy'), []);
  assert.deepEqual(await titles('anchor OR lan?erns'), ['Invented anchor', 'Lanterns pack']);
  assert.deepEqual(await titles('anchor OR l*erns^2'), ['Lanterns pack', 'Invented anchor']);
  assert.deepEqual(await titles('lantern AND lanterns'), [], 'plain words remain exact terms');
});

test('searchindex treats a malformed request query as literal terms and keeps paging', async (t) => {
  const { page } = await searchSite(t);
  const found = await page({ q: '(lantern -lanterns', ps: '1', page: '2' });
  assert.equal(found.total, 2);
  assert.deepEqual(
    found.items.map(({ n, title }) => [n, title]),
    [[2, 'Lanterns pack']],
  );
  assert.equal((await page({ q: '(*' })).total, 0, 'punctuation-only input must not become an empty query');
});

test('searchindex omits highlighted fragments when a query uses wildcards', async (t) => {
  const { page } = await searchSite(t);
  const prefix = await page({ q: 'lantern*', ps: '1', page: '2' });
  assert.equal(prefix.total, 2);
  assert.deepEqual(
    prefix.items.map(({ n, title, fragment }) => [n, title, fragment]),
    [[2, 'Lanterns pack', null]],
  );
  const mixed = await page({ q: 'anchor OR lan?erns' });
  assert.deepEqual(
    mixed.items.map(({ title, fragment }) => [title, fragment]),
    [
      ['Invented anchor', null],
      ['Lanterns pack', null],
    ],
  );
  const literal = await page({ q: '(lantern*' });
  assert.equal(literal.total, 1);
  assert.match(literal.items[0].fragment, /<em>lantern<\/em>/);
});

test('searchindex rejects an unsupported filter even when the visitor query recovers', async (t) => {
  const { sim } = await searchSite(t);
  const query = new URLSearchParams({ q: '(lantern', filter: 'unsupported' });
  const response = await fetch(`${sim.url}/?${query}`);
  assert.equal(response.status, 501);
  assert.doesNotMatch(await response.text(), /Invented lantern/);
  assert.match(JSON.stringify(sim.state().diagnostics), /PORTAL_SEARCH_FILTER_UNSUPPORTED/);
});

test('literal query recovery preserves the local length and nesting bounds', () => {
  const code = { code: 'PORTAL_SEARCH_QUERY_INVALID' };
  assert.throws(() => compilePortalSearchQuery('('.repeat(17), { recoverSyntax: true }), code);
  assert.throws(() => compilePortalSearchQuery('x'.repeat(1025), { recoverSyntax: true }), code);
  assert.throws(() => compilePortalSearchQuery('(lantern'), code);
});

test('the default search result pager preserves the current query and record type', async (t) => {
  const { sim } = await searchSite(t, { moreItems: 11 });
  const first = await fetch(sim.url + '/search/?q=paging%20probe&logicalNames=x_item');
  assert.equal(first.status, 200);
  const firstHtml = await first.text();
  assert.match(firstHtml, /Paging fixture 01/);
  assert.doesNotMatch(firstHtml, /Paging fixture 11/);
  const next = /<a rel="next" href="([^"]+)"/.exec(firstHtml)?.[1].replaceAll('&amp;', '&');
  assert.equal(next, '/search/?q=paging+probe&page=2&logicalNames=x_item');
  const secondHtml = await (await fetch(sim.url + next)).text();
  assert.match(secondHtml, /Paging fixture 11/);
  assert.doesNotMatch(secondHtml, /Paging fixture 01|rel="next"/);
  assert.match(secondHtml, /rel="prev" href="\/search\/\?q=paging\+probe&amp;page=1&amp;logicalNames=x_item"/);
});

// @test-kind security: record-type facets expose names and counts only for results this visitor can read.
test('default record-type facets group readable results without exposing restricted table matches', async (t) => {
  const { sim } = await searchSite(t, {
    settings: [
      ['Search/EnableAdditionalEntities', 'true'],
      ['Search/RecordTypeFacetsEntities', 'Matching fixtures:x_item,x_secret'],
    ],
  });
  const search = async (headers) => (await fetch(sim.url + '/search/?q=lantern', { headers })).text();
  const anonymous = await search();
  assert.match(anonymous, /aria-label="Record Type"/);
  assert.match(anonymous, /logicalNames=x_item">Matching fixtures \(1\)/);
  assert.doesNotMatch(anonymous, /x_secret|Invented lantern secret/);
  const member = await search(signInHeaders(sim, 'alex', { roles: ['Member'] }));
  assert.match(member, /logicalNames=x_item%2Cx_secret">Matching fixtures \(2\)/);
});

test('the default /search/ page renders the search results markup and states a disabled search', async () => {
  const { renderPortalSearchPage } = await import('../lib/portal-search.mjs');
  const diagnostics = [];
  const html = await renderPortalSearchPage({
    portal: { settings: { 'Search/Enabled': 'false', 'Search/Query': '+(@Query)' } },
    params: new URLSearchParams('q=<lantern>'),
    diagnostic: (entry) => diagnostics.push(entry.code),
  });
  assert.match(html, /data-mirage-component="portal-search"/);
  assert.match(html, /value="&lt;lantern&gt;"/);
  assert.match(html, /Search is not enabled for this site\./);
  assert.deepEqual(diagnostics, ['PORTAL_SEARCH_QUERY_WEIGHTS_LOCAL', 'PORTAL_SEARCH_DISABLED']);
});

// Knowledge articles are searchable only when Published with Internal set to No, and the platform does not let a site
// change that. The store row decides, never the view's projected columns.
test('knowledge article eligibility does not depend on the Portal Search view columns', async (t) => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-search-ka-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'portal/website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented search`,
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html':
      '<main id=probe>{% searchindex query: request.params.q %}{% for r in searchindex.results %}<li>{{ r.title }}</li>{% endfor %}{% endsearchindex %}</main>',
    'portal/sitesetting.yml': '[]',
    'portal/webrole.yml': '- adx_webroleid: anonymous\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true',
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedKa</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/knowledgearticle/Entity.xml': entity('knowledgearticle', [
      'title',
      'isinternal',
      'statecode',
    ]).replace('<PrimaryNameAttribute>x_name', '<PrimaryNameAttribute>title'),
    // The view selects only the title: neither statecode nor isinternal is projected.
    'solution/Entities/knowledgearticle/SavedQueries/search.xml': view(
      'knowledgearticle',
      '77777777-7777-4777-8777-777777777723',
      'Portal Search',
      ['title'],
    ),
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const initial = {
    version: 1,
    mappings: {
      knowledgearticle: { entitySet: 'knowledgearticles', idColumn: 'knowledgearticleid', nameColumn: 'title' },
    },
    tables: {
      contact: [],
      knowledgearticle: [
        {
          knowledgearticleid: '77777777-7777-4777-8777-777777777931',
          title: 'Lantern internal',
          isinternal: true,
          statecode: 3,
        },
        {
          knowledgearticleid: '77777777-7777-4777-8777-777777777932',
          title: 'Lantern public',
          isinternal: false,
          statecode: 3,
        },
        {
          knowledgearticleid: '77777777-7777-4777-8777-777777777933',
          title: 'Lantern draft',
          isinternal: false,
          statecode: 0,
        },
        // No stored isinternal: the platform default is No, so the article is searchable.
        { knowledgearticleid: '77777777-7777-4777-8777-777777777934', title: 'Lantern unflagged', statecode: 3 },
      ],
    },
    permissions: [
      { id: 'ka', entity: 'knowledgearticle', scope: 'global', roles: ['Anonymous Users'], operations: ['read'] },
    ],
    settings: { permissionMode: 'enforce' },
    simulator: {
      mode: 'local',
      pageMode: 'local',
      permissionSource: 'configured',
      live: { allowWrites: false },
      endpoints: [],
    },
  };
  const sim = await createSimulator({
    sourceDir: path.join(dir, 'portal'),
    solutionRoots: [path.join(dir, 'solution')],
    port: 0,
    watch: false,
    initial,
  });
  ownedFixture(t).add(() => sim.close());
  const html = await (await fetch(`${sim.url}/?q=lantern`)).text();
  const main = /<main id=probe>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? html;
  assert.deepEqual([...main.matchAll(/<li>([^<]*)<\/li>/g)].map((match) => match[1]).sort(), [
    'Lantern public',
    'Lantern unflagged',
  ]);
});
