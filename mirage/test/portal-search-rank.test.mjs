// @test-kind unproven: local relevance model built from the ranking factors Learn documents for Power Pages global search (power-pages/configure/search/overview "Global search", "Boosting a term", Search/Query row); hosted scores and exact order are not captured, so only the direction of each factor is asserted
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { compilePortalSearchQuery, compilePortalSearchTemplate } from '../lib/portal-search-query.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const LEARN_SEARCH = 'https://learn.microsoft.com/power-pages/configure/search/overview';
const score = (query, values, options) => compilePortalSearchQuery(query, options).score(values);
/** `first` outranks `second` for `query`; both match. */
function outranks(query, first, second, why, options) {
  const a = score(query, first, options);
  const b = score(query, second, options);
  assert.notEqual(a, null, `${why}: ${JSON.stringify(first)} matches`);
  assert.notEqual(b, null, `${why}: ${JSON.stringify(second)} matches`);
  assert.ok(a > b, `${LEARN_SEARCH}: ${why} (${a} > ${b})`);
}

test('more matched query words rank higher', () => {
  outranks('bright lantern', ['bright lantern harbour'], ['old lantern harbour'], 'number of words matched');
  outranks('bright lantern', ['bright', 'lantern'], ['lantern', 'quay'], 'words matched in separate columns count too');
});

test('the smaller the text holding the words, the higher the rank', () => {
  outranks('lantern', ['lantern'], ['lantern on the old harbour quay'], 'a short column outranks a long one');
  outranks('lantern', ['quay', 'lantern'], ['lantern on the old harbour quay'], 'the best column decides');
  outranks('lantern', ['lantern lantern quay'], ['lantern harbour quay'], 'more occurrences in as much text');
});

test('query words close together rank higher than the same words far apart', () => {
  outranks('bright lantern', ['bright lantern a b c d'], ['bright a b c d lantern'], 'proximity of plain words');
  outranks('bright old lantern', ['lantern x bright old x x'], ['bright x x old x lantern'], 'the tightest window');
  outranks('"bright lantern"~4', ['bright lantern a b c'], ['bright a b c lantern'], 'a tighter sloppy phrase match');
  outranks('"bright lantern"~4', ['bright lantern a b c'], ['lantern bright a b c'], 'in order before reversed');
});

test('term and phrase boosts weigh their clause, a boost below 1 included', () => {
  outranks('anchor lantern^3', ['lantern quay'], ['anchor quay'], 'a boosted word outranks an unboosted one');
  outranks('anchor^0.2 lantern', ['lantern quay'], ['anchor quay'], 'a boost below 1 lowers its word');
  outranks('"old quay"^4 lantern', ['old quay x'], ['lantern x y'], 'a boosted phrase');
});

test('exact matches outrank fuzzy expansions and wildcard terms ignore term frequency', () => {
  outranks('lantern~1', ['lantern quay'], ['lanterns quay'], 'an exact token over a fuzzy one');
  outranks('lantern~1', ['lantern quay'], ['lantren quay'], 'an exact token over a transposition', {
    legacyLucene: false,
  });
  assert.equal(
    score('lant*', ['lantern lantern']),
    score('lant*', ['lantern lanterns']),
    'a prefix term counts its best column once, whatever the frequency',
  );
  outranks('lant*', ['lantern'], ['lantern on the quay'], 'a prefix term still prefers a short column');
});

test('ranking keeps membership: excluded and unmatched rows stay unmatched', () => {
  assert.equal(score('lantern -quay', ['lantern quay']), null);
  assert.equal(score('+anchor lantern', ['lantern lantern lantern']), null);
  assert.equal(score('lantern', ['anchor']), null);
  assert.equal(score('', ['anything']), 0, 'an empty query keeps every row at the same rank');
});

test('Search/Query weights rank the default search page: title, table and field clauses add their boosts', () => {
  const visitor = compilePortalSearchQuery('lantern');
  const record = (logicalName, title, note = '') => ({
    logicalName,
    columns: [
      ['x_name', title],
      ['x_note', note],
    ],
  });
  const titled = compilePortalSearchTemplate('+(@Query) _title:(@Query)', visitor);
  const inTitle = titled.rank(record('x_item', 'Invented lantern', 'quay guide'));
  const inNote = titled.rank(record('x_item', 'Invented quay', 'lantern guide'));
  assert.ok(inTitle > inNote, `_title:(@Query) weighs a title match again (${inTitle} > ${inNote})`);
  const tables = compilePortalSearchTemplate('+(@Query) _logicalname:x_page~0.9^0.2', visitor);
  const page = tables.rank(record('x_page', 'Invented lantern'));
  const item = tables.rank(record('x_item', 'Invented lantern'));
  assert.ok(page > item, 'a table clause with ^0.2 lifts its table over an equal match');
  assert.ok(page - item < 0.25, 'by about its boost');
  const field = compilePortalSearchTemplate('+(@Query) x_note:(@Query)^2', visitor);
  assert.ok(
    field.rank(record('x_item', 'Invented quay', 'lantern guide')) >
      field.rank(record('x_item', 'Invented lantern', 'quay guide')),
    'a boosted field clause outranks the title',
  );
  assert.equal(titled.rank(record('x_item', 'Invented anchor')), null, 'the required clause still excludes');
  assert.equal(titled.admits(record('x_item', 'Invented anchor')), false);
});

const SITE = '79797979-7979-4797-9797-797979797901';
const id = (n) => `79797979-7979-4797-9797-7979797979${String(n).padStart(2, '0')}`;
const entity = (name, columns) =>
  `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}"><EntitySetName>${name}s</EntitySetName><PrimaryIdAttribute>${name}id</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="${name}id"><Name>${name}id</Name><Type>primarykey</Type></attribute>${columns.map((column) => `<attribute PhysicalName="${column}"><Name>${column}</Name><Type>nvarchar</Type><displaynames><displayname description="${column}" languagecode="1033"/></displaynames></attribute>`).join('')}</attributes></entity></EntityInfo></Entity>`;
const view = (table, viewId, columns) =>
  `<savedquery><savedqueryid>{${viewId}}</savedqueryid><querytype>0</querytype><isdefault>0</isdefault><LocalizedNames><LocalizedName description="Portal Search" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="${table}">${columns.map((column) => `<attribute name="${column}"/>`).join('')}</entity></fetch></fetchxml><layoutxml><grid><row>${columns.map((column) => `<cell name="${column}" width="100"/>`).join('')}</row></grid></layoutxml></savedquery>`;

async function rankSite(t, settings) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-search-rank-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const all = [['Search/EnableAdditionalEntities', 'true'], ...settings];
  const files = {
    'portal/website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented ranking`,
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html':
      '<main id=probe>{% searchindex query: request.params.q %}{% for r in searchindex.results %}<li>{{ r.title }}</li>{% endfor %}{% endsearchindex %}</main>',
    'portal/sitesetting.yml': all
      .map(([name, value], index) => `- adx_sitesettingid: s${index}\n  adx_name: ${name}\n  adx_value: "${value}"`)
      .join('\n'),
    'portal/webrole.yml': '- adx_webroleid: anonymous\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true',
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedRanking</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/x_item/Entity.xml': entity('x_item', ['x_name', 'x_note']),
    'solution/Entities/x_item/SavedQueries/search.xml': view('x_item', id(80), ['x_name', 'x_note']),
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const sim = await createSimulator({
    sourceDir: path.join(dir, 'portal'),
    solutionRoots: [path.join(dir, 'solution')],
    port: 0,
    watch: false,
    initial: {
      version: 1,
      mappings: { x_item: { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name' } },
      tables: {
        x_item: [
          // The title-only match sorts last by title, so only the template's weight can lift it.
          { x_itemid: id(1), x_name: 'Zephyr lantern', x_note: 'quay guide' },
          { x_itemid: id(2), x_name: 'Anchor guide', x_note: 'quay lantern' },
        ],
      },
      permissions: [
        { id: 'items', entity: 'x_item', scope: 'global', roles: ['Anonymous Users'], operations: ['read'] },
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
  const read = async (pathname) => {
    const response = await fetch(`${sim.url}${pathname}`);
    assert.equal(response.status, 200);
    return response.text();
  };
  return {
    page: async (q) =>
      [
        ...(await read(`/search/?${new URLSearchParams({ q })}`)).matchAll(/<li data-logical-name="[^"]+">([^<]*)/g),
      ].map((match) => match[1]),
    liquid: async (q) =>
      [...(await read(`/?${new URLSearchParams({ q })}`)).matchAll(/<li>([^<]*)<\/li>/g)].map((match) => match[1]),
    diagnostics: () => (sim.state().diagnostics ?? []).map((entry) => entry.code),
  };
}

test('the default search page ranks a Search/Query title match first; the Liquid tag keeps the plain model', async (t) => {
  const site = await rankSite(t, [['Search/Query', '+(@Query) _title:(@Query)']]);
  assert.deepEqual(await site.page('lantern'), ['Zephyr lantern', 'Anchor guide'], '_title:(@Query) lifts the title');
  assert.ok(site.diagnostics().includes('PORTAL_SEARCH_QUERY_WEIGHTS_LOCAL'));
  assert.ok(site.diagnostics().includes('PORTAL_SEARCH_RANKING_LOCAL'), 'the local order is reported');
  // Without the template both rows match in an equally short column: the local tie order is by title.
  assert.deepEqual(await site.liquid('lantern'), ['Anchor guide', 'Zephyr lantern']);
  assert.deepEqual(await site.liquid('guide quay'), ['Zephyr lantern', 'Anchor guide'], 'adjacent words in one column');
});
