// @test-kind unproven: standard data model content access levels; Learn power-pages/templates/dynamics-365-apps/manage-knowledge-articles-content-levels documents the KnowledgeManagement/ContentAccessLevel/Enabled setting (default false) and the level sources (web roles, contact, parent contact, account), and the any-one-level rule is a local model; hosted session F3 (AUTH-07c) could not observe it, because its site used the enhanced data model
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { knowledgeArticleAccess } from '../lib/content-access-levels.mjs';
import { signInHeaders } from '../testing.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { browserToken } from './support/browser-request-token.mjs';

const G = (n) => `5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a${String(n).padStart(4, '0')}`;
const SITE = G(1);
const ARTICLE_PAGE = G(2);
const VIEW = G(3);
// Levels: Default, Registered, Premium, Account, Contact and an inactive one.
const LEVEL = {
  default: G(11),
  registered: G(12),
  premium: G(13),
  account: G(14),
  contact: G(15),
  retired: G(16),
};
const ARTICLE = {
  default: G(21),
  registered: G(22),
  premium: G(23),
  account: G(24),
  contact: G(25),
  unleveled: G(26),
  multiple: G(27),
  retired: G(28),
};
const TITLE = {
  default: 'Lantern default',
  registered: 'Lantern registered',
  premium: 'Lantern premium',
  account: 'Lantern account',
  contact: 'Lantern contact',
  unleveled: 'Lantern unleveled',
  multiple: 'Lantern multiple',
  retired: 'Lantern retired',
};
const ACCOUNT = G(31);
const CLOSED_ACCOUNT = G(32);
// Contacts: plain signed-in, Premium role member, direct contact level, child of that contact, child of the account,
// and inactive targets: a contact of an inactive account, the child of an inactive contact, a member of an inactive role.
const CONTACT = {
  plain: G(41),
  premium: G(42),
  direct: G(43),
  child: G(44),
  employee: G(45),
  closedEmployee: G(46),
  dormant: G(47),
  heir: G(48),
  veteran: G(49),
};

const attribute = (name, type) =>
  `<attribute PhysicalName="${name}"><Name>${name}</Name><Type>${type}</Type></attribute>`;
const entity = (name, primaryName, columns) =>
  `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}"><EntitySetName>${name}s</EntitySetName><PrimaryIdAttribute>${name}id</PrimaryIdAttribute><PrimaryNameAttribute>${primaryName}</PrimaryNameAttribute><attributes>${attribute(`${name}id`, 'primarykey')}${Object.entries(
    columns,
  )
    .map(([column, type]) => attribute(column, type))
    .join('')}</attributes></entity></EntityInfo></Entity>`;
// An invented intersect name per relationship: the module must read them from the Solution metadata.
const manyToMany = (name, first, second, intersect) =>
  `<EntityRelationship Name="${name}"><EntityRelationshipType>ManyToMany</EntityRelationshipType><FirstEntityName>${first}</FirstEntityName><SecondEntityName>${second}</SecondEntityName><IntersectEntityName>${intersect}</IntersectEntityName><Entity1IntersectAttribute>${first}id</Entity1IntersectAttribute><Entity2IntersectAttribute>${second}id</Entity2IntersectAttribute><EntityRelationshipRoles><EntityRelationshipRole><AssociationRoleOrdinal>1</AssociationRoleOrdinal><NavigationPropertyName>${name}_1</NavigationPropertyName></EntityRelationshipRole><EntityRelationshipRole><AssociationRoleOrdinal>2</AssociationRoleOrdinal><NavigationPropertyName>${name}_2</NavigationPropertyName></EntityRelationshipRole></EntityRelationshipRoles></EntityRelationship>`;

async function knowledgeSite(t, { enabled = true, articleRelationship = true, dataModel, observed } = {}) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'knowledge-cal-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const levelTable = 'adx_contentaccesslevel';
  const relationships = [
    ...(articleRelationship ? [manyToMany('x_level_article', levelTable, 'knowledgearticle', 'x_level_article')] : []),
    // The level table is the second entity here, so the module must read the orientation from the metadata.
    manyToMany('x_role_level', 'adx_webrole', levelTable, 'x_role_level'),
    manyToMany('x_contact_level', 'contact', levelTable, 'x_contact_level'),
    manyToMany('x_level_account', levelTable, 'account', 'x_level_account'),
  ];
  const files = {
    'portal/website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented knowledge`,
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Article.webpage.yml': `adx_webpageid: ${ARTICLE_PAGE}\nadx_name: Article\nadx_partialurl: article\nadx_parentpageid: home\nadx_pagetemplateid: plain`,
    'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html':
      "<main id=probe>{% searchindex query: 'lantern', page_size: 50 %}<p id=n>{{ searchindex.approximate_total_hits }}</p>{% for r in searchindex.results %}<i>{{ r.title }}</i>{% endfor %}{% endsearchindex %}<ul>{% for a in knowledge.articles %}<b>{{ a.title }}</b>{% endfor %}</ul></main>",
    // fetchxml and entities over the articles (the F3 probe page's three reads, with knowledge.articles on Main).
    'portal/Reads.webpage.yml':
      'adx_webpageid: reads\nadx_name: Reads\nadx_partialurl: reads\nadx_parentpageid: home\nadx_pagetemplateid: reads',
    'portal/Reads.pagetemplate.yml': 'adx_pagetemplateid: reads\nadx_webtemplateid: reads',
    'portal/Reads.webtemplate.yml': 'adx_webtemplateid: reads\nadx_name: Reads',
    'portal/Reads.webtemplate.source.html':
      '<main id=reads>{% fetchxml q %}<fetch><entity name="knowledgearticle"><attribute name="title"/></entity></fetch>{% endfetchxml %}{% for r in q.results.entities %}<f>{{ r.title }}</f>{% endfor %}' +
      Object.values(ARTICLE)
        .map((id) => `{% assign e = entities.knowledgearticle['${id}'] %}{% if e %}<e>{{ e.title }}</e>{% endif %}`)
        .join('') +
      '</main>',
    'portal/Plain.pagetemplate.yml': 'adx_pagetemplateid: plain\nadx_webtemplateid: plain',
    'portal/Plain.webtemplate.yml': 'adx_webtemplateid: plain\nadx_name: Plain',
    'portal/Plain.webtemplate.source.html': '<main>Invented article page</main>',
    'portal/sitesetting.yml': `- adx_sitesettingid: s1\n  adx_name: KnowledgeManagement/ContentAccessLevel/Enabled\n  adx_value: "${enabled}"`,
    'portal/sitemarker.yml': `- adx_sitemarkerid: m1\n  adx_name: Knowledge Article\n  adx_pageid: ${ARTICLE_PAGE}`,
    'portal/webrole.yml': [
      '- adx_webroleid: anonymous\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true',
      '- adx_webroleid: authenticated\n  adx_name: Authenticated Users\n  adx_authenticatedusersrole: true',
      '- adx_webroleid: premium\n  adx_name: Premium',
      '- adx_webroleid: retiredrole\n  adx_name: Retired role\n  statecode: 1',
    ].join('\n'),
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedKnowledge</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Other/Relationships.xml': `<EntityRelationships>${relationships.join('')}</EntityRelationships>`,
    'solution/Entities/knowledgearticle/Entity.xml': entity('knowledgearticle', 'title', {
      title: 'nvarchar',
      content: 'ntext',
      isinternal: 'bit',
    }),
    'solution/Entities/knowledgearticle/SavedQueries/search.xml': `<savedquery><savedqueryid>{${VIEW}}</savedqueryid><querytype>0</querytype><LocalizedNames><LocalizedName description="Portal Search" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="knowledgearticle"><attribute name="title"/><attribute name="content"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="title" width="100"/><cell name="content" width="100"/></row></grid></layoutxml></savedquery>`,
    'solution/Entities/adx_contentaccesslevel/Entity.xml': entity(levelTable, 'adx_name', { adx_name: 'nvarchar' }),
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const link = (from, to) => (pairs) => pairs.map(([left, right]) => ({ [`${from}id`]: left, [`${to}id`]: right }));
  const sources = [];
  const summaryPack = {
    id: 'invented-knowledge-summary',
    name: 'Invented knowledge summary',
    description: 'Invented local provider that records the summary sources',
    matches: () => true,
    presets: () => ({}),
    portalSearchSummary(input) {
      sources.push(input.sources.map((source) => source.id).sort());
      return { summary: 'invented summary', citationIds: input.sources.map((source) => source.id) };
    },
  };
  const sim = await createSimulator({
    sourceDir: path.join(dir, 'portal'),
    solutionRoots: [path.join(dir, 'solution')],
    packs: [summaryPack],
    ...(dataModel ? { dataModel } : {}),
    ...(observed ? { observed } : {}),
    port: 0,
    watch: false,
    initial: {
      version: 1,
      tables: {
        account: [
          { accountid: ACCOUNT, name: 'Invented account' },
          { accountid: CLOSED_ACCOUNT, name: 'Invented closed account', statecode: 1 },
        ],
        contact: [
          { contactid: CONTACT.plain, fullname: 'Invented plain', statecode: 0 },
          { contactid: CONTACT.premium, fullname: 'Invented premium', statecode: 0 },
          { contactid: CONTACT.direct, fullname: 'Invented direct', statecode: 0 },
          {
            contactid: CONTACT.child,
            fullname: 'Invented child',
            statecode: 0,
            parentcustomerid: { id: CONTACT.direct, logical_name: 'contact' },
          },
          {
            contactid: CONTACT.employee,
            fullname: 'Invented employee',
            statecode: 0,
            parentcustomerid: { id: ACCOUNT, logical_name: 'account' },
          },
          {
            contactid: CONTACT.closedEmployee,
            fullname: 'Invented closed employee',
            statecode: 0,
            parentcustomerid: { id: CLOSED_ACCOUNT, logical_name: 'account' },
          },
          { contactid: CONTACT.dormant, fullname: 'Invented dormant', statecode: 1 },
          {
            contactid: CONTACT.heir,
            fullname: 'Invented heir',
            statecode: 0,
            parentcustomerid: { id: CONTACT.dormant, logical_name: 'contact' },
          },
          { contactid: CONTACT.veteran, fullname: 'Invented veteran', statecode: 0 },
        ],
        knowledgearticle: Object.entries(ARTICLE).map(([key, id]) => ({
          knowledgearticleid: id,
          title: TITLE[key],
          content: `${TITLE[key]} text`,
          statecode: 3,
          isinternal: false,
        })),
        adx_contentaccesslevel: Object.entries(LEVEL).map(([key, id]) => ({
          adx_contentaccesslevelid: id,
          adx_name: key,
          statecode: key === 'retired' ? 1 : 0,
        })),
        x_level_article: link(
          'adx_contentaccesslevel',
          'knowledgearticle',
        )([
          [LEVEL.default, ARTICLE.default],
          [LEVEL.registered, ARTICLE.registered],
          [LEVEL.premium, ARTICLE.premium],
          [LEVEL.account, ARTICLE.account],
          [LEVEL.contact, ARTICLE.contact],
          [LEVEL.premium, ARTICLE.multiple],
          [LEVEL.contact, ARTICLE.multiple],
          [LEVEL.retired, ARTICLE.retired],
        ]),
        // The Default level reaches anonymous and signed-in visitors through their roles.
        x_role_level: link(
          'adx_webrole',
          'adx_contentaccesslevel',
        )([
          ['anonymous', LEVEL.default],
          ['authenticated', LEVEL.default],
          ['authenticated', LEVEL.registered],
          ['premium', LEVEL.premium],
          ['authenticated', LEVEL.retired],
          ['retiredrole', LEVEL.premium],
        ]),
        x_contact_level: link(
          'contact',
          'adx_contentaccesslevel',
        )([
          [CONTACT.direct, LEVEL.contact],
          [CONTACT.dormant, LEVEL.contact],
        ]),
        x_level_account: link(
          'adx_contentaccesslevel',
          'account',
        )([
          [LEVEL.account, ACCOUNT],
          [LEVEL.account, CLOSED_ACCOUNT],
        ]),
      },
      permissions: [
        {
          id: 'ka',
          entity: 'knowledgearticle',
          scope: 'global',
          roles: ['Anonymous Users', 'Authenticated Users'],
          operations: ['read'],
        },
      ],
      settings: { permissionMode: 'enforce' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        permissionSource: 'configured',
        contactRoles: [
          { contactId: CONTACT.premium, roleId: 'premium' },
          { contactId: CONTACT.veteran, roleId: 'retiredrole' },
        ],
        live: { allowWrites: false },
        endpoints: [],
      },
    },
  });
  ownedFixture(t).add(() => sim.close());
  const as = (contact) => (contact ? signInHeaders(sim, contact) : {});
  const titles = (html, tag) => [...html.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((m) => m[1]).sort();
  const home = async (contact) => {
    const response = await fetch(`${sim.url}/`, { headers: as(contact) });
    const html = await response.text();
    assert.equal(response.status, 200, html);
    const main = /<main id=probe>([\s\S]*?)<\/main>/.exec(html)[1];
    return {
      total: Number(/<p id=n>(\d*)<\/p>/.exec(main)[1]),
      search: titles(main, 'i'),
      articles: titles(main, 'b'),
    };
  };
  const defaultSearch = async (contact) => {
    const response = await fetch(`${sim.url}/search/?q=lantern`, { headers: as(contact) });
    const html = await response.text();
    assert.equal(response.status, 200, html);
    return {
      status: /<p role="status">([^<]*)<\/p>/.exec(html)?.[1],
      facet: /knowledgearticle \((\d+)\)/.exec(html)?.[1] ?? null,
      items: [...html.matchAll(/<li data-logical-name="knowledgearticle"><a href="[^"]*">([^<]*)<\/a>/g)]
        .map((m) => m[1])
        .sort(),
    };
  };
  const summarySources = async (contact) => {
    const headers = as(contact);
    const { token, cookie } = await browserToken(sim, headers);
    sources.length = 0;
    const response = await fetch(`${sim.url}/_api/search/v1.0/summary`, {
      method: 'POST',
      body: new URLSearchParams({ userQuery: 'lantern' }),
      headers: {
        origin: sim.url,
        'x-requested-with': 'XMLHttpRequest',
        __requestverificationtoken: token,
        ...headers,
        cookie,
      },
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    return { ids: sources[0] ?? [], body };
  };
  const reads = async (contact) => {
    const response = await fetch(`${sim.url}/reads/`, { headers: as(contact) });
    const html = await response.text();
    assert.equal(response.status, 200, html);
    const main = /<main id=reads>([\s\S]*?)<\/main>/.exec(html)[1];
    return { fetchxml: titles(main, 'f'), entities: titles(main, 'e') };
  };
  const articlePage = (contact) => fetch(`${sim.url}/article/`, { headers: as(contact) });
  return { sim, home, defaultSearch, summarySources, reads, articlePage };
}

const titlesOf = (...keys) => keys.map((key) => TITLE[key]).sort();
const idsOf = (...keys) => keys.map((key) => ARTICLE[key]).sort();

test('disabled content access levels leave every published article in search and knowledge.articles', async (t) => {
  const { home } = await knowledgeSite(t, { enabled: false });
  const all = Object.values(TITLE).sort();
  assert.deepEqual(await home(), { total: all.length, search: all, articles: all });
});

test('the Default level reaches anonymous visitors and the Authenticated Users levels reach signed-in contacts', async (t) => {
  const { home } = await knowledgeSite(t);
  const anonymous = titlesOf('default');
  assert.deepEqual(await home(), { total: 1, search: anonymous, articles: anonymous });
  const signedIn = titlesOf('default', 'registered');
  assert.deepEqual(await home(CONTACT.plain), { total: 2, search: signedIn, articles: signedIn });
});

test('levels are inherited from web roles, the contact, its parent contact and its account', async (t) => {
  const { home } = await knowledgeSite(t);
  const premium = titlesOf('default', 'registered', 'premium', 'multiple');
  assert.deepEqual(await home(CONTACT.premium), { total: 4, search: premium, articles: premium });
  const direct = titlesOf('default', 'registered', 'contact', 'multiple');
  assert.deepEqual(await home(CONTACT.direct), { total: 4, search: direct, articles: direct });
  assert.deepEqual(await home(CONTACT.child), { total: 4, search: direct, articles: direct }, 'parent contact');
  const employee = titlesOf('default', 'registered', 'account');
  assert.deepEqual(await home(CONTACT.employee), { total: 3, search: employee, articles: employee }, 'account');
});

// @test-kind unproven: the documentation does not say whether an article needs any or all of its levels, or what an article with no level does; the local model admits an article that shares any level and hides one with none
test('an article with several levels needs any one of them and an article with no level stays hidden', async (t) => {
  const { home } = await knowledgeSite(t);
  for (const contact of [CONTACT.premium, CONTACT.direct]) {
    const found = await home(contact);
    assert.ok(found.search.includes(TITLE.multiple) && found.articles.includes(TITLE.multiple), contact);
    assert.ok(!found.search.includes(TITLE.unleveled) && !found.articles.includes(TITLE.unleveled), contact);
  }
});

// @test-kind security: hidden knowledge articles never reach a visitor through result totals, record-type facet counts, result lists or summary sources
test('totals, facet counts and summary sources do not leak hidden articles', async (t) => {
  const { defaultSearch, summarySources } = await knowledgeSite(t);
  assert.deepEqual(await defaultSearch(), { status: '1 result(s)', facet: '1', items: titlesOf('default') });
  assert.deepEqual(await defaultSearch(CONTACT.employee), {
    status: '3 result(s)',
    facet: '3',
    items: titlesOf('default', 'registered', 'account'),
  });
  const anonymous = await summarySources();
  assert.deepEqual(anonymous.ids, idsOf('default'));
  for (const hidden of [ARTICLE.premium, ARTICLE.contact, ARTICLE.unleveled])
    assert.ok(!anonymous.body.includes(hidden));
  assert.deepEqual((await summarySources(CONTACT.premium)).ids, idsOf('default', 'registered', 'premium', 'multiple'));
});

// @test-kind security: an enabled filter without a level-to-article relationship in the Solution metadata hides every article instead of showing them all
test('a missing level-to-article relationship hides every article and reports it', async (t) => {
  const { home, sim } = await knowledgeSite(t, { articleRelationship: false });
  assert.deepEqual(await home(CONTACT.premium), { total: 0, search: [], articles: [] });
  assert.match(JSON.stringify(sim.state().diagnostics ?? []), /KNOWLEDGE_CONTENT_ACCESS_UNRESOLVED/);
});

// @test-kind contract: the module answers null when the site setting is off, so callers keep their unfiltered behaviour
test('knowledgeArticleAccess is null unless the site setting is true', () => {
  const store = {
    resolveMapping: () => ({ relationships: {} }),
    tableRows: () => [],
    state: {},
  };
  const portal = (value) => ({
    settings: value == null ? {} : { 'KnowledgeManagement/ContentAccessLevel/Enabled': value },
  });
  assert.equal(knowledgeArticleAccess({ portal: portal(null), store, identity: {} }), null);
  assert.equal(knowledgeArticleAccess({ portal: portal('false'), store, identity: {} }), null);
  assert.notEqual(knowledgeArticleAccess({ portal: portal('true'), store, identity: {} }), null);
});

// @test-kind security: an inactive content access level, account, parent contact or web role grants no article
test('inactive levels and inactive link targets grant no access', async (t) => {
  const { home, sim } = await knowledgeSite(t);
  const signedIn = titlesOf('default', 'registered');
  // The retired level is linked to Authenticated Users and to its article, but is inactive.
  assert.deepEqual(await home(CONTACT.plain), { total: 2, search: signedIn, articles: signedIn });
  for (const contact of [CONTACT.closedEmployee, CONTACT.heir, CONTACT.veteran])
    assert.deepEqual(await home(contact), { total: 2, search: signedIn, articles: signedIn }, contact);
  // The inactive role grants nothing even when an identity names it directly.
  const access = knowledgeArticleAccess({
    portal: sim.portal,
    store: sim.store,
    identity: { roleSource: 'memberships', roleIds: ['retiredrole'], roles: ['Retired role'] },
  });
  assert.deepEqual(access.levels, []);
  assert.equal(access.visible(ARTICLE.premium), false);
});

// @test-kind security: with live data, a missing or failing live read path fails closed (no article is shown unfiltered) and reports that once
test('live data without a readable live source hides every knowledge article and reports it once', async (t) => {
  const { sim } = await knowledgeSite(t);
  const diagnostics = [];
  const read = (identity, readProvider) =>
    knowledgeArticleAccess({
      portal: sim.portal,
      store: sim.store,
      identity,
      config: { mode: 'live' },
      readProvider,
      diagnostic: (entry) => diagnostics.push([entry.code, entry.severity]),
    });
  const failing = {
    fetchXml: async () => {
      throw Object.assign(new Error('Live FetchXML returned HTTP 403.'), { status: 403 });
    },
    get: async () => ({ statecode: 0 }),
  };
  for (const identity of [{}, { contactId: CONTACT.premium, id: CONTACT.premium }])
    for (const access of [read(identity), await read(identity, failing)]) {
      assert.notEqual(access, null, 'an enabled filter never answers "no filter" with live data');
      assert.deepEqual(access.levels, []);
      for (const article of Object.values(ARTICLE)) assert.equal(access.visible(article), false, article);
    }
  assert.deepEqual(diagnostics, [['KNOWLEDGE_CONTENT_ACCESS_LIVE_HIDDEN', 'warning']]);
  // Local data on the same store still filters by level.
  const local = knowledgeArticleAccess({ portal: sim.portal, store: sim.store, identity: {} });
  assert.equal(local.visible(ARTICLE.default), true);
  assert.equal(local.visible(ARTICLE.premium), false);
  // The setting off still leaves live articles unfiltered, as it does local ones.
  assert.equal(
    knowledgeArticleAccess({ portal: { settings: {} }, store: sim.store, identity: {}, config: { mode: 'live' } }),
    null,
  );
});

// @test-kind security: with live data the content access levels, contacts and accounts read through the live read path give exactly the visibility the local rule gives, never wider
test('live data applies the content access level rule over rows read through the live read path', async (t) => {
  const { sim } = await knowledgeSite(t);
  // The live source: the same rows, reachable only through the read provider; the store holds metadata but no rows.
  const reads = [];
  const readProvider = {
    fetchXml: async (xml) => {
      reads.push(/<entity name="([^"]+)"/.exec(xml)[1]);
      return sim.store.fetchXml(xml, { admin: true });
    },
    get: async (table, id) => {
      reads.push(`${table}:${id}`);
      return sim.store.get(table, id, { admin: true });
    },
  };
  const metadataOnly = new Proxy(sim.store, {
    get(target, property) {
      if (property === 'tableRows') return () => [];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const identities = [
    {},
    ...Object.values(CONTACT).map((contactId) => ({ contactId, id: contactId })),
    { contactId: CONTACT.premium, id: CONTACT.premium, roleSource: 'memberships', roleIds: ['premium'] },
    { roleSource: 'memberships', roleIds: ['retiredrole'], roles: ['Retired role'] },
  ];
  for (const identity of identities) {
    const local = knowledgeArticleAccess({ portal: sim.portal, store: sim.store, identity });
    const live = await knowledgeArticleAccess({
      portal: sim.portal,
      store: metadataOnly,
      identity,
      config: { mode: 'live' },
      readProvider,
      diagnostic: (entry) => assert.fail(`${entry.code}: ${entry.message}`),
    });
    const label = JSON.stringify(identity);
    assert.deepEqual(live.levels, local.levels, label);
    for (const article of Object.values(ARTICLE))
      assert.equal(live.visible(article), local.visible(article), `${label} ${article}`);
  }
  assert.ok(reads.includes('adx_contentaccesslevel') && reads.includes('knowledgearticle'), reads.join());
  // A signed-in contact with levels sees exactly its articles over the live rows.
  const premium = await knowledgeArticleAccess({
    portal: sim.portal,
    store: metadataOnly,
    identity: { contactId: CONTACT.premium, id: CONTACT.premium, roleSource: 'memberships', roleIds: ['premium'] },
    config: { mode: 'live' },
    readProvider,
  });
  assert.equal(premium.visible(ARTICLE.premium), true);
  assert.equal(premium.visible(ARTICLE.unleveled), false);
});

// @test-kind security: with content access levels on, entities.knowledgearticle answers nil for an article outside the visitor's levels by default, as knowledge.articles and search do; on an enhanced site, where the hosted platform returns it (F3 AUTH-07c), Mirage still hides it and warns
test('entities.knowledgearticle keeps the content access level filter by default', async (t) => {
  const enhanced = await knowledgeSite(t, { dataModel: 'enhanced' });
  for (const contact of [undefined, CONTACT.plain, CONTACT.premium, CONTACT.direct, CONTACT.employee])
    assert.deepEqual(await enhanced.reads(contact), { fetchxml: [], entities: [] }, contact ?? 'anonymous');
  const warning = enhanced.sim
    .state()
    .diagnostics.find((item) => item.code === 'KNOWLEDGE_CONTENT_ACCESS_ENTITIES_UNFILTERED');
  assert.equal(warning?.severity, 'warning');
  assert.match(warning.message, /observed\.knowledgeEntitiesContentAccess/);
  const standard = await knowledgeSite(t);
  assert.deepEqual((await standard.reads()).entities, titlesOf('default'));
  assert.deepEqual(
    (await standard.reads(CONTACT.premium)).entities,
    titlesOf('default', 'registered', 'premium', 'multiple'),
  );
});

// @test-kind observation: hosted session F3 (paqvilo-developer hosted-f3 summary-F3.md AUTH-07c, Customer Self-Service site on the enhanced data model, cs-cal-off-repaired, cs-cal-default-roles, cs-cal-contact-A, -AB and -A-roleB captures of runs a and b, 2026-11-27): with the setting on, knowledge.articles and fetchxml return no article for every persona, entities[] still returns every article (reproduced with observed.knowledgeEntitiesContentAccess unfiltered), and the Knowledge Article page answers 500 with RTDV01 adx_webrolecontentaccesslevel not found in the MetadataCache
test('an enhanced site with content access levels on shows no article through knowledge.articles or fetchxml', async (t) => {
  const { sim, home, reads, articlePage } = await knowledgeSite(t, {
    dataModel: 'enhanced',
    observed: { knowledgeEntitiesContentAccess: 'unfiltered', evidence: 'Invented loopback observation' },
  });
  const every = Object.values(TITLE).sort();
  for (const contact of [undefined, CONTACT.plain, CONTACT.premium, CONTACT.direct, CONTACT.employee]) {
    assert.deepEqual(await home(contact), { total: 0, search: [], articles: [] }, contact ?? 'anonymous');
    assert.deepEqual(await reads(contact), { fetchxml: [], entities: every }, contact ?? 'anonymous');
    const page = await articlePage(contact);
    assert.equal(page.status, 500, contact ?? 'anonymous');
  }
  const codes = sim.state().diagnostics.map((item) => item.code);
  assert.ok(codes.includes('KNOWLEDGE_CONTENT_ACCESS_ENHANCED'));
  assert.ok(codes.includes('KNOWLEDGE_CONTENT_ACCESS_ENTITIES_UNFILTERED'));
  assert.ok(codes.includes('KNOWLEDGE_CONTENT_ACCESS_TABLE_MISSING'));
});

// @test-kind observation: hosted session F3 (summary-F3.md AUTH-07c, cs-cal-off-repaired of runs a and b): with the setting off, knowledge.articles, fetchxml and entities list every article and the article page answers 200
test('an enhanced site with content access levels off lists every article everywhere', async (t) => {
  const { home, reads, articlePage } = await knowledgeSite(t, { dataModel: 'enhanced', enabled: false });
  const every = Object.values(TITLE).sort();
  assert.deepEqual((await home()).articles, every);
  assert.deepEqual(await reads(), { fetchxml: every, entities: every });
  assert.equal((await articlePage()).status, 200);
});

// @test-kind observation: hosted session F3 (summary-F3.md AUTH-07c, runs a and b): the generic error page of the enhanced article page carries the RTDV01 server log entry naming adx_webrolecontentaccesslevel
test('the enhanced article page failure carries the RTDV01 entry on the generic error page', async (t) => {
  const { sim } = await knowledgeSite(t, {
    dataModel: 'enhanced',
    observed: { pageErrorPresentation: 'generic-error', evidence: 'Invented loopback observation' },
  });
  const body = await (await fetch(`${sim.url}/article/`)).text();
  assert.match(body, /"MessageCode": "RTDV01"/);
  assert.match(
    body,
    /Error Message from Dataverse: The entity with a name = 'adx_webrolecontentaccesslevel' with namemapping = 'Logical' was not found in the MetadataCache\./,
  );
});

// @test-kind observation: hosted session F3 (summary-F3.md AUTH-07c): an article created through the API carries no level, and the template's Default level is linked to no web role; Mirage adds no link, so on the standard model such an article is hidden
test('Mirage invents no level link for a new article or the Default level', async (t) => {
  const { sim, home } = await knowledgeSite(t);
  // Created as the hosted fixture created it: a plain create, no level named.
  await sim.store.create(
    'knowledgearticle',
    {
      knowledgearticleid: G(29),
      title: 'Lantern created',
      content: 'Lantern created text',
      statecode: 3,
      isinternal: false,
    },
    { admin: true },
  );
  const links = sim.store.tableRows('x_level_article').filter((row) => row.knowledgearticleid === G(29));
  assert.deepEqual(links, []);
  assert.ok(!(await home()).articles.includes('Lantern created'));
  // A Default level linked to no web role reaches no visitor.
  await sim.store.transact(() => {
    const rows = sim.store.tableRows('x_role_level');
    rows.splice(0, rows.length, ...rows.filter((row) => row.adx_contentaccesslevelid !== LEVEL.default));
  });
  assert.deepEqual((await home()).articles, []);
});
