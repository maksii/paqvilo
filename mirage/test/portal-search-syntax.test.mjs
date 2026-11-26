// @test-kind contract: local portal search keeps the documented syntax bounded: malformed proximity, fuzzy and template input never escapes as anything but PORTAL_SEARCH_QUERY_INVALID, and the Liquid tag recovers it as plain text
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { compilePortalSearchQuery, compilePortalSearchTemplate } from '../lib/portal-search-query.mjs';
import { signInHeaders } from '../testing.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const LEARN_SEARCH = 'https://learn.microsoft.com/power-pages/configure/search/overview';
const LEARN_ATTACHMENTS = 'https://learn.microsoft.com/power-pages/configure/search/file-attachment';
const SITE = '78787878-7878-4787-8787-787878787801';
const DETAILS = '78787878-7878-4787-8787-787878787802';
const ARTICLE_PAGE = '78787878-7878-4787-8787-787878787803';
const id = (n) => `78787878-7878-4787-8787-7878787879${String(n).padStart(2, '0')}`;
const matches = (query, values, options) => compilePortalSearchQuery(query, options).score(values) !== null;
const invalid = { code: 'PORTAL_SEARCH_QUERY_INVALID' };
const legacy = { legacyLucene: true };

// @test-kind compatibility: Learn power-pages/configure/search/overview "Proximity search": "Picture blurry"~10 finds the two words within 10 words of each other
test('proximity search finds phrase words within the slop and an exact phrase stays adjacent', () => {
  const near = ['the picture was taken at dusk and came out blurry'];
  assert.equal(matches('"picture blurry"', near), false, `${LEARN_SEARCH}: a phrase without ~ stays exact`);
  assert.equal(matches('"picture blurry"~10', near), true);
  const far = [`picture ${'word '.repeat(20)}blurry`];
  assert.equal(matches('"picture blurry"~10', far), false);
  assert.equal(matches('"picture blurry"~10^2', near), true, 'a boost may follow the slop');
  assert.equal(matches('"picture blurry"~10', ['picture', 'blurry']), false, 'a phrase cannot span two columns');
});

// @test-kind unproven: local model of the Lucene sloppy phrase rule (max(position - offset) - min(position - offset) <= slop); reversed words cost two moves; no native capture
test('a sloppy phrase measures position moves, so reversed words need a slop of two', () => {
  assert.equal(matches('"lantern bright"~1', ['bright lantern']), false);
  assert.equal(matches('"lantern bright"~2', ['bright lantern']), true);
  assert.equal(
    matches('"lantern lantern"~3', ['one lantern only']),
    false,
    'a repeated phrase word needs two positions',
  );
  assert.equal(matches('"lantern lantern"~3', ['lantern and lantern']), true);
  assert.equal(matches('"bright lantern"~', ['bright lantern']), true, 'a slop without a number is 0');
  assert.equal(matches('"bright lantern"~', ['bright old lantern']), false);
});

// @test-kind compatibility: Learn power-apps/developer/data-platform/search/query "Fuzzy search" (Uniersty~ returns University, Blue~1 returns glue and blues) and Lucene 2.9 query parser syntax "Fuzzy Searches" (roam~ finds foam and roams; roam~0.8 takes a similarity between 0 and 1)
test('fuzzy terms follow Dataverse search edit distances and the legacy Lucene similarity', () => {
  assert.equal(matches('Uniersty~', ['University of Invention']), true);
  assert.equal(matches('Blue~1', ['glue']), true);
  assert.equal(matches('Blue~1', ['blues']), true);
  assert.equal(matches('blue', ['glue']), false, 'without ~ a term stays exact');
  assert.equal(matches('roam~', ['foam'], legacy), true);
  assert.equal(matches('roam~', ['roams'], legacy), true);
  assert.equal(matches('roam~0.8', ['roam'], legacy), true);
});

// @test-kind unproven: local model of the fuzzy rules from the Lucene sources the docs cite (classic parser 6.6 for Dataverse search: ~N edits capped at 2, a similarity below 1 converted by FuzzyQuery.floatToEdits, transpositions count once, a match must keep part of the shorter term; Lucene 2.9 for Lucene .NET: 1 - distance / shorter length must exceed the similarity, no transpositions); no native capture
test('fuzzy edit and similarity bounds of both search engines', () => {
  assert.equal(matches('blue~0', ['glue']), false, '~0 is exact');
  assert.equal(matches('lantren~1', ['lantern']), true, 'a transposition is one edit');
  assert.equal(matches('lanterns~0.8', ['lantern']), true, '0.8 of 8 characters allows one edit');
  assert.equal(matches('lantern~0.9', ['lanterns']), false, '0.9 of 7 characters allows no edit');
  assert.equal(matches('lantern~5', ['lan']), false, 'the edit distance is capped at 2');
  assert.equal(matches('ab~', ['cd']), false, 'two edits consume a two-character term');
  assert.equal(matches('roam~0.8', ['foam'], legacy), false, '1 - 1/4 is not above 0.8');
  assert.equal(matches('lantren~0.7', ['lantern'], legacy), true, 'two Levenshtein edits over 7: 0.714 > 0.7');
  assert.equal(matches('lantren~0.75', ['lantern'], legacy), false);
  assert.equal(matches('lant*~1', ['lantern']), true, 'a wildcard term ignores the fuzzy modifier');
  assert.equal(matches('lantern^2~1', ['lanterns']), true, 'a fuzzy modifier may follow the boost');
  const search = compilePortalSearchQuery('lantren~1');
  assert.equal(search.highlight('lantern'), true, 'a fuzzy match is highlighted');
});

test('malformed fuzzy modifiers are syntax errors in strict mode and plain text when recovered', () => {
  assert.throws(() => compilePortalSearchQuery('lantern~1.5'), invalid, 'a fractional edit distance');
  assert.throws(() => compilePortalSearchQuery('lantern~1', legacy), invalid, 'a legacy similarity of 1');
  assert.throws(() => compilePortalSearchQuery('lantern~0.5^0'), invalid, 'a zero boost after a slop');
  const recovered = compilePortalSearchQuery('lantern~1.5', { recoverSyntax: true });
  assert.notEqual(recovered.score(['lantern']), null);
  assert.equal(recovered.score(['lanterns']), null, 'recovered text has no fuzzy matching');
  for (const query of ['~', '~~', '"~"', '"a b"~x', 'a~~b', '"~', '~^2', 'a~-1', '(~)', 'a~0.5~0.5'])
    assert.doesNotThrow(() => compilePortalSearchQuery(query).score(['a b']), query);
});

test('a proximity search over a repetitive column stays within the local work limit', () => {
  const column = ['a '.repeat(30000)];
  const repeated = `"${'a '.repeat(40).trim()}"~5`;
  for (const options of [{}, { recoverSyntax: true }])
    assert.throws(() => compilePortalSearchQuery(repeated, options).score(column), {
      ...invalid,
      message: /local work limit/,
    });
  assert.notEqual(compilePortalSearchQuery('"a a a"~5').score(column), null, 'an ordinary phrase still runs');
});

test('random queries over the new operators either compile or answer PORTAL_SEARCH_QUERY_INVALID', () => {
  const parts = [
    'a',
    'ab',
    'lantern',
    '"',
    '~',
    '~1',
    '~0.5',
    '~2.5',
    '^',
    '^2',
    '*',
    '?',
    '(',
    ')',
    ' ',
    '+',
    '-',
    ':',
  ];
  parts.push('AND', 'OR', 'NOT', '@Query', '_logicalname:', '_title:', '.', '0', '9');
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let run = 0; run < 3000; run++) {
    const query = Array.from({ length: 1 + Math.floor(next() * 12) }, () => parts[Math.floor(next() * parts.length)])
      .join(next() < 0.5 ? '' : ' ')
      .slice(0, 200);
    for (const options of [{}, legacy, { recoverSyntax: true }, { recoverSyntax: true, legacyLucene: true }]) {
      try {
        compilePortalSearchQuery(query, options).score(['a lantern ab', 'lantern']);
      } catch (error) {
        assert.equal(error.code, 'PORTAL_SEARCH_QUERY_INVALID', `${JSON.stringify(query)}: ${error.message}`);
        if (options.recoverSyntax) assert.match(error.message, /limit/, `${JSON.stringify(query)} recovers`);
      }
    }
    try {
      compilePortalSearchTemplate(query, compilePortalSearchQuery('lantern'))?.admits({
        logicalName: 'x_item',
        columns: [['x_name', 'lantern']],
      });
    } catch (error) {
      assert.equal(error.code, 'PORTAL_SEARCH_QUERY_INVALID', `template ${JSON.stringify(query)}: ${error.message}`);
    }
  }
});

// @test-kind compatibility: Learn power-pages/configure/search/overview Search/Query row (the default +(@Query) _title:(@Query) _logicalname:...~0.9^0.2 -_logicalname:...~0.9 value) and the Lucene 2.9 query parser "Fields" section (a field applies to the term or group it directly precedes)
test('a Search/Query template keeps its required, prohibited and field clauses', () => {
  const visitor = compilePortalSearchQuery('lantern');
  const template = compilePortalSearchTemplate(
    '+(@Query) _title:(@Query) _logicalname:x_page~0.9^0.2 -_logicalname:x_hidden~0.9 x_url:(@Query)',
    visitor,
  );
  const record = (logicalName, title, note = '') => ({
    logicalName,
    columns: [
      ['x_name', title],
      ['x_note', note],
    ],
  });
  assert.equal(template.admits(record('x_item', 'Invented lantern')), true);
  assert.equal(template.admits(record('x_item', 'Invented anchor', 'lantern inside')), true, 'title is optional');
  assert.equal(template.admits(record('x_item', 'Invented anchor')), false, '+(@Query) is required');
  assert.equal(template.admits(record('x_hidden', 'Invented lantern')), false, 'the prohibited table');
  const titled = compilePortalSearchTemplate('+_title:(@Query)', visitor);
  assert.equal(titled.admits(record('x_item', 'Invented anchor', 'lantern inside')), false);
  assert.equal(titled.admits(record('x_item', 'Invented lantern')), true);
  const optional = compilePortalSearchTemplate('_logicalname:x_item _logicalname:x_page', visitor);
  assert.equal(optional.admits(record('x_page', 'anything')), true, 'without a required clause one optional matches');
  assert.equal(optional.admits(record('x_other', 'Invented lantern')), false);
  assert.equal(
    compilePortalSearchTemplate('+(@Query)', compilePortalSearchQuery('')).admits(record('x_item', 'x')),
    true,
    'an empty visitor query keeps matching every row',
  );
});

// @test-kind unproven: local choice: @Query stands for the separately parsed visitor query, so visitor text cannot close or extend the template's own groups; native expansion is not captured
test('the visitor query is never re-parsed inside the template', () => {
  const visitor = compilePortalSearchQuery(') OR _logicalname:x_hidden (', { recoverSyntax: true });
  const template = compilePortalSearchTemplate('+(@Query) -_logicalname:x_hidden', visitor);
  assert.equal(template.admits({ logicalName: 'x_hidden', columns: [['x_name', 'x_hidden']] }), false);
  assert.throws(() => compilePortalSearchTemplate('+(@Query', visitor), invalid);
  assert.throws(() => compilePortalSearchTemplate('_title:', visitor), invalid);
});

const entity = (name, columns, { collection, primary = 'x_name' } = {}) =>
  `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}">${collection ? `<LocalizedCollectionNames><LocalizedCollectionName description="${collection}" languagecode="1033"/></LocalizedCollectionNames>` : ''}<EntitySetName>${name}s</EntitySetName><PrimaryIdAttribute>${name}id</PrimaryIdAttribute><PrimaryNameAttribute>${primary}</PrimaryNameAttribute><attributes><attribute PhysicalName="${name}id"><Name>${name}id</Name><Type>primarykey</Type></attribute>${columns.map((column) => `<attribute PhysicalName="${column}"><Name>${column}</Name><Type>nvarchar</Type><displaynames><displayname description="${column}" languagecode="1033"/></displaynames></attribute>`).join('')}</attributes></entity></EntityInfo></Entity>`;
const view = (table, viewId, columns, filter = '') =>
  `<savedquery><savedqueryid>{${viewId}}</savedqueryid><querytype>0</querytype><isdefault>0</isdefault><LocalizedNames><LocalizedName description="Portal Search" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="${table}">${columns.map((column) => `<attribute name="${column}"/>`).join('')}${filter}</entity></fetch></fetchxml><layoutxml><grid><row>${columns.map((column) => `<cell name="${column}" width="100"/>`).join('')}</row></grid></layoutxml></savedquery>`;
const base64 = (value) => Buffer.from(value).toString('base64');
const note = (n, article, values) => ({
  annotationid: id(n),
  objectid: { id: article, logical_name: 'knowledgearticle' },
  objecttypecode: 'knowledgearticle',
  ...values,
});

async function syntaxSite(t, { settings = [], annotationRead = true, securedBody = false } = {}) {
  // Column security binds portal readers in the enhanced authorization model (annotation-download-access.test.mjs).
  const enhanced = securedBody ? '\nadx_enhancedauthorization: 3' : '';
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-search-syntax-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const allSettings = [['Search/EnableAdditionalEntities', 'true'], ...settings];
  const files = {
    'portal/website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented syntax search${enhanced}`,
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Details.webpage.yml': `adx_webpageid: ${DETAILS}\nadx_name: Details\nadx_partialurl: item\nadx_parentpageid: home\nadx_pagetemplateid: main`,
    'portal/Article.webpage.yml': `adx_webpageid: ${ARTICLE_PAGE}\nadx_name: Article\nadx_partialurl: article\nadx_parentpageid: home\nadx_pagetemplateid: main`,
    'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html':
      '<main id=probe>{% searchindex query: request.params.q, logical_names: request.params.ln %}<p id=n>{{ searchindex.approximate_total_hits }}</p>{% for r in searchindex.results %}<li data-ln="{{ r.logical_name }}" data-url="{{ r.url }}" data-parent="{{ r.parent.title }}">{{ r.title }}|{{ r.fragment }}</li>{% endfor %}{% endsearchindex %}</main>',
    'portal/sitesetting.yml': allSettings
      .map(([name, value], index) => `- adx_sitesettingid: s${index}\n  adx_name: ${name}\n  adx_value: "${value}"`)
      .join('\n'),
    'portal/webrole.yml':
      '- adx_webroleid: member\n  adx_name: Member\n- adx_webroleid: anonymous\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true',
    'portal/sitemarker.yml': `- adx_sitemarkerid: m1\n  adx_name: x_item_SearchResultPage\n  adx_pageid: ${DETAILS}\n- adx_sitemarkerid: m2\n  adx_name: Knowledge Article\n  adx_pageid: ${ARTICLE_PAGE}`,
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedSyntax</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/x_item/Entity.xml': entity('x_item', ['x_name', 'x_note'], { collection: 'Invented items' }),
    'solution/Entities/x_item/SavedQueries/search.xml': view('x_item', id(80), ['x_name', 'x_note']),
    'solution/Entities/x_secret/Entity.xml': entity('x_secret', ['x_name']),
    'solution/Entities/x_secret/SavedQueries/search.xml': view('x_secret', id(81), ['x_name']),
    'solution/Entities/knowledgearticle/Entity.xml': entity(
      'knowledgearticle',
      ['title', 'content', 'isinternal', 'statecode'],
      { primary: 'title' },
    ),
    'solution/Entities/knowledgearticle/SavedQueries/search.xml': view('knowledgearticle', id(82), [
      'title',
      'content',
    ]),
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const published = id(30);
  const internal = id(31);
  const sim = await createSimulator({
    sourceDir: path.join(dir, 'portal'),
    solutionRoots: [path.join(dir, 'solution')],
    port: 0,
    watch: false,
    initial: {
      version: 1,
      mappings: {
        x_item: { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name' },
        x_secret: { entitySet: 'x_secrets', idColumn: 'x_secretid', nameColumn: 'x_name' },
        knowledgearticle: { entitySet: 'knowledgearticles', idColumn: 'knowledgearticleid', nameColumn: 'title' },
        annotation: {
          entitySet: 'annotations',
          idColumn: 'annotationid',
          ...(securedBody
            ? { fields: { documentbody: { dataverseType: 'nvarchar', columnMetadata: { isSecured: true } } } }
            : {}),
        },
      },
      tables: {
        contact: [{ contactid: 'alex', fullname: 'Alex Local', statecode: 0 }],
        x_item: [
          { x_itemid: id(1), x_name: 'Invented lantern', x_note: 'bright lantern' },
          { x_itemid: id(2), x_name: 'Invented anchor', x_note: 'heavy lantern' },
          { x_itemid: id(3), x_name: 'Lanterns pack', x_note: 'many' },
        ],
        x_secret: [{ x_secretid: id(5), x_name: 'Invented lantern secret' }],
        knowledgearticle: [
          { knowledgearticleid: published, title: 'Harbour guide', content: 'quay', isinternal: false, statecode: 3 },
          { knowledgearticleid: internal, title: 'Harbour internal', content: 'quay', isinternal: true, statecode: 3 },
        ],
        annotation: [
          // Seeded bodies move to the annotations storage route; the search reads them as the visitor.
          note(46, published, {
            subject: 'Stored',
            notetext: '*WEB* kept in storage',
            filename: 'stored.txt',
            mimetype: 'text/plain',
            documentbody: base64('distant glimmer'),
          }),
          note(47, published, {
            subject: '*PRIVATE* [contact:someone-else]',
            notetext: '*WEB* private file',
            filename: 'private.txt',
            mimetype: 'text/plain',
            documentbody: base64('hidden glimmer'),
          }),
          note(48, published, {
            subject: 'Unprefixed',
            notetext: 'not for the web',
            filename: 'unprefixed.txt',
            mimetype: 'text/plain',
            documentbody: base64('unlisted glimmer'),
          }),
          note(41, published, { subject: 'Remark', notetext: '*WEB* a glowing remark' }),
          note(42, published, { subject: 'Draft', notetext: 'glowing but not for the web' }),
          note(43, published, {
            subject: 'Scan',
            notetext: '*WEB* scanned',
            filename: 'scan.pdf',
            mimetype: 'application/pdf',
            documentbody: base64('%PDF glowing'),
          }),
          note(44, published, { subject: '*PRIVATE* [contact:someone-else]', notetext: '*WEB* glowing private' }),
          note(45, internal, { subject: 'Internal', notetext: '*WEB* glowing internal' }),
        ],
      },
      permissions: [
        { id: 'items', entity: 'x_item', scope: 'global', roles: ['Anonymous Users', 'Member'], operations: ['read'] },
        { id: 'secret', entity: 'x_secret', scope: 'global', roles: ['Member'], operations: ['read'] },
        {
          id: 'ka',
          entity: 'knowledgearticle',
          scope: 'global',
          roles: ['Anonymous Users', 'Member'],
          operations: ['read'],
        },
        ...(annotationRead
          ? [
              {
                id: 'notes',
                entity: 'annotation',
                scope: 'global',
                roles: ['Anonymous Users', 'Member'],
                operations: ['read'],
              },
            ]
          : []),
      ],
      settings: { permissionMode: 'enforce' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        permissionSource: 'configured',
        live: { allowWrites: false },
        endpoints: [],
      },
    },
  });
  ownedFixture(t).add(() => sim.close());
  // A legacy row with its body inline, as the annotation download tests seed one.
  await sim.store.transact(() =>
    sim.store.state.tables.annotation.push(
      note(40, published, {
        subject: 'Beacon notes',
        notetext: '*WEB* attached file',
        filename: 'beacon.txt',
        mimetype: 'text/plain',
        documentbody: base64('the glowing beacon manual'),
      }),
    ),
  );
  const liquid = async (query, headers = {}) => {
    const response = await fetch(`${sim.url}/?${new URLSearchParams(query)}`, { headers });
    const html = await response.text();
    assert.equal(response.status, 200, html.slice(0, 500));
    const main = /<main id=probe>([\s\S]*?)<\/main>/.exec(html)[1];
    return {
      total: Number(/<p id=n>(\d*)<\/p>/.exec(main)[1]),
      items: [
        ...main.matchAll(/<li data-ln="([^"]*)" data-url="([^"]*)" data-parent="([^"]*)">([^|]*)\|([\s\S]*?)<\/li>/g),
      ].map(([, ln, url, parent, title, fragment]) => ({ ln, url, parent, title, fragment })),
    };
  };
  const page = async (query, headers = {}) => {
    const response = await fetch(`${sim.url}/search/?${new URLSearchParams(query)}`, { headers });
    return { status: response.status, html: await response.text() };
  };
  const diagnostics = () => JSON.stringify(sim.state().diagnostics ?? []);
  return { sim, liquid, page, diagnostics };
}

const titlesOf = (html) => [...html.matchAll(/<li data-logical-name="([^"]+)">(?:<a href="[^"]*">)?([^<]*)/g)];

test('the Liquid tag and the default page run proximity and fuzzy queries over the secured scan', async (t) => {
  const { liquid, page } = await syntaxSite(t);
  const fuzzy = await liquid({ q: 'lantren~1' });
  assert.deepEqual(fuzzy.items.map((item) => item.title).sort(), ['Invented anchor', 'Invented lantern']);
  assert.match(fuzzy.items.find((item) => item.title === 'Invented lantern').fragment, /<em>lantern<\/em>/);
  assert.equal((await liquid({ q: '"lantern bright"~2' })).total, 1);
  // The Liquid tag treats a malformed fuzzy modifier as plain text; the default search page refuses it.
  assert.equal((await liquid({ q: 'lantern~1.5' })).total, 2);
  assert.equal((await page({ q: 'lantern~1.5' })).status, 400);
  assert.equal((await page({ q: 'lantren~1' })).status, 200);
});

// @test-kind compatibility: Learn power-pages/configure/search/overview Search/Query row: the weights and filters apply to the default search page only, never to the searchindex Liquid tag
test('Search/Query filters the default search page but not the Liquid tag', async (t) => {
  const { sim, liquid, page, diagnostics } = await syntaxSite(t, {
    settings: [['Search/Query', '+(@Query) _title:(@Query) _logicalname:x_item~0.9^0.2 -_logicalname:x_secret~0.9']],
  });
  const member = signInHeaders(sim, 'alex', { roles: ['Member'] });
  const html = (await page({ q: 'lantern' }, member)).html;
  // Membership only: the order is the local relevance model's (portal-search-rank.test.mjs).
  assert.deepEqual(
    titlesOf(html)
      .map(([, ln, title]) => [ln, title])
      .sort(([, a], [, b]) => a.localeCompare(b)),
    [
      ['x_item', 'Invented anchor'],
      ['x_item', 'Invented lantern'],
    ],
  );
  assert.doesNotMatch(html, /Invented lantern secret/);
  assert.ok((await liquid({ q: 'lantern' }, member)).items.some((item) => item.ln === 'x_secret'));
  assert.match(diagnostics(), /PORTAL_SEARCH_QUERY_WEIGHTS_LOCAL/);
});

test('an invalid Search/Query template is reported and the visitor query runs alone', async (t) => {
  const { page, diagnostics } = await syntaxSite(t, { settings: [['Search/Query', '+(@Query']] });
  const { status, html } = await page({ q: 'lantern' });
  assert.equal(status, 200);
  assert.match(html, /role="status">2 result\(s\)/);
  assert.match(diagnostics(), /PORTAL_SEARCH_QUERY_TEMPLATE_INVALID/);
});

// @test-kind compatibility: Learn power-pages/configure/search/overview Search/Filters row: name:logical,names pairs separated by semicolons add drop-down filter options; an option shows the plural name of its first table
test('Search/Filters adds the logical name drop-down to the default search page', async (t) => {
  const { sim, page } = await syntaxSite(t, {
    settings: [['Search/Filters', 'Things:x_item,x_secret;Unlisted:x_missing; broken']],
  });
  const member = signInHeaders(sim, 'alex', { roles: ['Member'] });
  const { html } = await page({ q: 'lantern', logicalNames: 'x_item,x_secret' }, member);
  assert.match(
    html,
    /<select name="logicalNames" aria-label="All"><option value="">All<\/option><option value="x_item,x_secret" selected>Invented items<\/option><option value="x_missing">Unlisted<\/option><\/select>/,
  );
  assert.doesNotMatch(html, /type="hidden" name="logicalNames"/);
  const filtered = await page({ q: 'lantern', logicalNames: 'x_secret' }, member);
  assert.deepEqual(
    titlesOf(filtered.html).map(([, ln]) => ln),
    ['x_secret'],
  );
  assert.match(filtered.html, /<option value="" selected>All<\/option>/, 'a value outside the options selects All');
});

// @test-kind security+compatibility: Learn power-pages/configure/search/file-attachment: Search/IndexNotesAttachments and KnowledgeManagement/DisplayNotes set to True index knowledge article notes; only notes the visitor's annotation read returns, with the NotesFilter prefix, of searchable articles, ever reach results, counts or facets
test('knowledge article notes are searched only when enabled and only where the visitor may read them', async (t) => {
  const enabled = [
    ['Search/IndexNotesAttachments', 'true'],
    ['KnowledgeManagement/DisplayNotes', 'true'],
    ['Search/RecordTypeFacetsEntities', 'Downloads:annotation'],
  ];
  const { liquid, page, diagnostics } = await syntaxSite(t, { settings: enabled });
  const found = await liquid({ q: 'glowing' });
  // Membership and each result's links; the order between them is the local relevance model's.
  assert.deepEqual(
    found.items.map(({ ln, title, parent }) => [ln, title, parent]).sort(([, a], [, b]) => a.localeCompare(b)),
    [
      ['annotation', 'beacon.txt', 'Harbour guide'],
      ['annotation', 'Remark', 'Harbour guide'],
    ],
    `${LEARN_ATTACHMENTS}: the note of the published article; no unprefixed, binary, private or internal-article note`,
  );
  assert.equal(found.total, 2);
  const beacon = found.items.find((item) => item.title === 'beacon.txt');
  const remark = found.items.find((item) => item.title === 'Remark');
  assert.match(beacon.url, new RegExp(`^/_entity/annotation/${id(40)}/`));
  assert.equal(remark.url, `/article/?id=${id(30)}`, 'a note without a file links to its article');
  assert.match(beacon.fragment, /<em>glowing<\/em>/);
  assert.equal((await liquid({ q: 'quay' })).items.length, 1, 'the article itself is still found');
  assert.equal((await liquid({ q: 'glowing', ln: 'knowledgearticle' })).total, 0);
  assert.equal((await liquid({ q: 'manual', ln: 'annotation' })).total, 1, 'the text body is indexed');
  assert.match(diagnostics(), /PORTAL_SEARCH_ATTACHMENT_NOT_INDEXED[^}]*application\/pdf/);
  // A text body in the annotations storage route is read on both surfaces; a private or unprefixed note's body is not.
  const stored = await liquid({ q: 'glimmer' });
  assert.deepEqual(
    stored.items.map(({ ln, title, fragment }) => [ln, title, fragment]),
    [['annotation', 'stored.txt', 'distant <em>glimmer</em>']],
  );
  const storedHtml = (await page({ q: 'glimmer' })).html;
  assert.match(storedHtml, /role="status">1 result\(s\)/);
  assert.match(storedHtml, />stored\.txt<\/a><p>distant <em>glimmer<\/em><\/p>/);
  assert.doesNotMatch(storedHtml, /hidden|unlisted|private\.txt|unprefixed/);
  assert.doesNotMatch(diagnostics(), /PORTAL_SEARCH_ATTACHMENT_BODY_UNAVAILABLE/);
  const html = (await page({ q: 'glowing' })).html;
  assert.match(html, /Downloads \(2\)/);
  assert.match(html, /Related article: <a href="\/article\/\?id=/);
  assert.doesNotMatch(html, /private|internal|scan\.pdf|not for the web/i);

  for (const [name, options] of [
    ['notes off', { settings: [['Search/IndexNotesAttachments', 'true']] }],
    ['no annotation read', { settings: enabled, annotationRead: false }],
  ]) {
    await t.test(name, async (check) => {
      const site = await syntaxSite(check, options);
      assert.equal((await site.liquid({ q: 'glowing' })).total, 0);
      const closed = (await site.page({ q: 'glowing' })).html;
      assert.match(closed, /role="status">0 result\(s\)/);
      assert.doesNotMatch(closed, /Downloads|beacon/);
      assert.doesNotMatch(site.diagnostics(), /PORTAL_SEARCH_NOTES_UNREAD/, 'a denied read is no read failure');
    });
  }
  await t.test('secured body column', async (check) => {
    const site = await syntaxSite(check, { settings: enabled, securedBody: true });
    assert.equal((await site.liquid({ q: 'manual' })).total, 0, 'the secured body is not indexed');
    assert.equal((await site.liquid({ q: 'glimmer' })).total, 0, 'nor a secured body in the storage route');
    assert.match((await site.page({ q: 'glimmer' })).html, /role="status">0 result\(s\)/);
    assert.equal((await site.liquid({ q: 'beacon' })).total, 1, 'the readable file name and subject still match');
    assert.equal((await site.liquid({ q: 'attached' })).total, 1, 'the readable note text still matches');
  });
});
