import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { signInHeaders } from '../testing.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const SITE = '77777777-7777-4777-8777-777777777710';
const DETAILS = '77777777-7777-4777-8777-777777777711';
const entity = (name, columns) =>
  `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}"><EntitySetName>${name}s</EntitySetName><PrimaryIdAttribute>${name}id</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="${name}id"><Name>${name}id</Name><Type>primarykey</Type></attribute>${columns.map((column) => `<attribute PhysicalName="${column}"><Name>${column}</Name><Type>nvarchar</Type><displaynames><displayname description="${column}" languagecode="1033"/></displaynames></attribute>`).join('')}</attributes></entity></EntityInfo></Entity>`;
const view = (table, id, name, columns, filter = '') =>
  `<savedquery><savedqueryid>{${id}}</savedqueryid><querytype>0</querytype><isdefault>0</isdefault><LocalizedNames><LocalizedName description="${name}" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="${table}">${columns.map((column) => `<attribute name="${column}"/>`).join('')}${filter}</entity></fetch></fetchxml><layoutxml><grid><row>${columns.map((column) => `<cell name="${column}" width="100"/>`).join('')}</row></grid></layoutxml></savedquery>`;

async function searchSite(t, { settings = [['Search/EnableAdditionalEntities', 'true']], markers = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-search-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'portal/website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented search`,
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Details.webpage.yml': `adx_webpageid: ${DETAILS}\nadx_name: Details\nadx_partialurl: item\nadx_parentpageid: home\nadx_pagetemplateid: main`,
    'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html':
      '<main id=probe>{% searchindex query: request.params.q, logical_names: request.params.ln, page: request.params.page, page_size: request.params.ps %}<p id=n>{{ searchindex.approximate_total_hits }}</p>{% for r in searchindex.results %}<li data-n="{{ r.number }}" data-url="{{ r.url }}" data-ln="{{ r.logical_name }}">{{ r.title }}|{{ r.fragment }}</li>{% endfor %}{% endsearchindex %}</main>',
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
    assert.equal(response.status, 200, html.slice(0, 500));
    const main = /<main id=probe>([\s\S]*?)<\/main>/.exec(html)[1];
    return {
      total: Number(/<p id=n>(\d*)<\/p>/.exec(main)[1]),
      items: [
        ...main.matchAll(/<li data-n="(\d+)" data-url="([^"]*)" data-ln="([^"]*)">([^|]*)\|([\s\S]*?)<\/li>/g),
      ].map(([, n, url, ln, title, fragment]) => ({ n: Number(n), url, ln, title, fragment })),
    };
  };
  return { sim, page, id };
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
  assert.deepEqual(diagnostics, ['PORTAL_SEARCH_QUERY_WEIGHTS_IGNORED', 'PORTAL_SEARCH_DISABLED']);
});

// Knowledge articles are searchable only when Published with Internal set to No, and the platform does not let a site
// change that. The store row decides, never the view's projected columns.
test('knowledge article eligibility does not depend on the Portal Search view columns', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-search-ka-'));
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
