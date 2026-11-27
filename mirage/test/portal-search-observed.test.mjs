// @test-kind observation: hosted session F3 (paqvilo-developer hosted-f3 summary-F3.md PAGE-04f, runs a and b, 2026-11-27): Dataverse search finds both lantern pages for lantern, lanterns, lantern AND lanterns, lanterns AND lantern, lantern* and "lantern", run finds running, catalog finds catalogue and runner finds nothing
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { signInHeaders } from '../testing.mjs';
import { compilePortalSearchQuery } from '../lib/portal-search-query.mjs';
import { searchStem } from '../lib/search-stemmer.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

// Invented pages shaped like the captured fixture: a title and one copy column each.
const ROWS = {
  guide: ['Invented Lantern guide', 'This guide explains how to light a lantern safely.'],
  catalogue: ['Invented Lanterns catalogue', 'Our catalogue lists many lanterns in brass and glass.'],
  club: ['Invented Running club', 'The club meets for running every week.'],
};
const found = (query, options) => {
  const search = compilePortalSearchQuery(query, options);
  return Object.keys(ROWS).filter((name) => search.score(ROWS[name]) !== null);
};

test('Dataverse search matches the captured word forms through their stems', () => {
  for (const query of ['lantern', 'lanterns', 'lantern AND lanterns', 'lanterns AND lantern', 'lantern*', '"lantern"'])
    assert.deepEqual(found(query), ['guide', 'catalogue'], query);
  assert.deepEqual(found('running'), ['club']);
  assert.deepEqual(found('run'), ['club']);
  assert.deepEqual(found('runner'), []);
  assert.deepEqual(found('catalogue'), ['catalogue']);
  assert.deepEqual(found('catalog'), ['catalogue']);
  assert.deepEqual(found('brass'), ['catalogue']);
  assert.deepEqual(['lantern', 'lanterns', 'run', 'running', 'runner', 'catalog', 'catalogue'].map(searchStem), [
    'lantern',
    'lantern',
    'run',
    'run',
    'runner',
    'catalog',
    'catalog',
  ]);
  assert.equal(compilePortalSearchQuery('lanterns').highlight('lantern'), true, 'a stem match is highlighted');
});

// @test-kind contract: the deprecated Lucene .NET search (Search/EnableDataverseSearch false) keeps exact terms; F3 captured Dataverse search only
test('legacy Lucene .NET search keeps plain words exact', () => {
  const legacyLucene = { legacyLucene: true };
  assert.deepEqual(found('lantern AND lanterns', legacyLucene), []);
  assert.deepEqual(found('lanterns', legacyLucene), ['catalogue']);
  assert.deepEqual(found('run', legacyLucene), []);
});

const SITE = '77777777-7777-4777-8777-777777777a10';
const DRAFT = '77777777-7777-4777-8777-777777777a11';
const PUBLISHED = '77777777-7777-4777-8777-777777777a12';
const MEMBER = '77777777-7777-4777-8777-777777777a13';
const entity = (name, columns) =>
  `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}"><EntitySetName>${name}s</EntitySetName><PrimaryIdAttribute>${name}id</PrimaryIdAttribute><PrimaryNameAttribute>adx_name</PrimaryNameAttribute><attributes><attribute PhysicalName="${name}id"><Name>${name}id</Name><Type>primarykey</Type></attribute>${columns.map((column) => `<attribute PhysicalName="${column}"><Name>${column}</Name><Type>nvarchar</Type></attribute>`).join('')}</attributes></entity></EntityInfo></Entity>`;

async function draftSite(t, observed) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-search-drafts-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const page = (id, name, url, copy, state) =>
    `adx_webpageid: ${id}\nadx_name: ${name}\nadx_partialurl: ${url}\nadx_parentpageid: home\nadx_pagetemplateid: main\nadx_copy: ${copy}\nadx_publishingstateid: ${state}`;
  const files = {
    'portal/website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented drafts`,
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Draft.webpage.yml': page('draft', 'Invented draft lantern', 'draft', 'unreleased lantern', DRAFT),
    'portal/Live.webpage.yml': page('live', 'Invented live lantern', 'live', 'released lantern', PUBLISHED),
    'portal/Member.webpage.yml': page('member', 'Invented member lantern', 'member', 'member lantern', PUBLISHED),
    'portal/MemberDraft.webpage.yml': page(
      'memberdraft',
      'Invented member draft lantern',
      'memberdraft',
      'member draft lantern',
      DRAFT,
    ),
    // Restrict Read to Member on the member pages: a visitor without the role never finds them.
    'portal/webpageaccesscontrolrule.yml': ['member', 'memberdraft']
      .map(
        (id) =>
          `- adx_webpageaccesscontrolruleid: rule-${id}\n  adx_webpageid: ${id}\n  adx_right: 2\n  adx_scope: 1\n  adx_webpageaccesscontrolrule_webrole:\n  - member`,
      )
      .join('\n'),
    'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html':
      '<main id=probe>{% searchindex query: request.params.q %}<p id=n>{{ searchindex.approximate_total_hits }}</p>{% for r in searchindex.results %}<li>{{ r.title }}</li>{% endfor %}{% endsearchindex %}</main>',
    'portal/publishingstate.yml': `- adx_publishingstateid: ${DRAFT}\n  adx_name: Draft\n  adx_isvisible: false\n- adx_publishingstateid: ${PUBLISHED}\n  adx_name: Published\n  adx_isvisible: true`,
    'portal/webrole.yml':
      '- adx_webroleid: member\n  adx_name: Member\n- adx_webroleid: anonymous\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true',
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedDrafts</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/adx_webpage/Entity.xml': entity('adx_webpage', ['adx_name', 'adx_copy']),
    'solution/Entities/adx_webpage/SavedQueries/search.xml':
      '<savedquery><savedqueryid>{77777777-7777-4777-8777-777777777a20}</savedqueryid><querytype>0</querytype><isdefault>0</isdefault><LocalizedNames><LocalizedName description="Portal Search" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="adx_webpage"><attribute name="adx_name"/><attribute name="adx_copy"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="adx_name" width="100"/><cell name="adx_copy" width="100"/></row></grid></layoutxml></savedquery>',
  };
  await Promise.all(
    Object.entries(files).map(async ([name, body]) => {
      const file = path.join(dir, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, body);
    }),
  );
  const sim = await createSimulator({
    sourceDir: path.join(dir, 'portal'),
    solutionRoots: [path.join(dir, 'solution')],
    port: 0,
    watch: false,
    ...(observed && { observed }),
    initial: {
      version: 1,
      mappings: { adx_webpage: { entitySet: 'adx_webpages', idColumn: 'adx_webpageid', nameColumn: 'adx_name' } },
      tables: { contact: [{ contactid: MEMBER, fullname: 'Invented member' }] },
      // No adx_webpage table permission: the F3 site found web pages for anonymous visitors without one.
      permissions: [],
      settings: { permissionMode: 'enforce' },
      simulator: { mode: 'local', pageMode: 'local', permissionSource: 'configured', endpoints: [] },
    },
  });
  ownedFixture(t).add(() => sim.close());
  const titles = async (member = false) => {
    const headers = member ? signInHeaders(sim, MEMBER, { roles: ['Member'] }) : {};
    const html = await (await fetch(`${sim.url}/?q=lantern`, { headers })).text();
    return [...html.matchAll(/<li>([^<]*)<\/li>/g)].map(([, title]) => title).sort();
  };
  const warnings = () =>
    sim.state().diagnostics.filter((item) => item.code === 'PORTAL_SEARCH_UNPUBLISHED_PAGES_EXCLUDED');
  return { titles, warnings };
}

// @test-kind security+observation: hosted session F3 (summary-F3.md PAGE-04f, runs a and b): search results list web pages, drafts included, to anonymous visitors on a site without an adx_webpage table permission; web page access rules keep a restricted page from visitors without its role, and Mirage keeps a page in a non-visible publishing state out for a visitor who cannot preview it, warns what the hosted site lists, and lists it only with observed.searchUnpublishedPages listed
test('search leaves draft web pages out by default and lists them only for an observed site', async (t) => {
  const excluded = await draftSite(t);
  assert.deepEqual(await excluded.titles(), ['Invented live lantern']);
  assert.deepEqual(await excluded.titles(true), ['Invented live lantern', 'Invented member lantern']);
  const [warning] = excluded.warnings();
  assert.equal(warning.severity, 'warning');
  assert.equal(warning.count, 2);
  assert.match(warning.message, /lists them, with their title and indexed text, to every visitor, anonymous ones/);
  assert.match(warning.message, /observed\.searchUnpublishedPages/);
  const listed = await draftSite(t, { searchUnpublishedPages: 'listed', evidence: 'Invented loopback observation' });
  assert.deepEqual(await listed.titles(), ['Invented draft lantern', 'Invented live lantern']);
  assert.deepEqual(await listed.titles(true), [
    'Invented draft lantern',
    'Invented live lantern',
    'Invented member draft lantern',
    'Invented member lantern',
  ]);
  assert.deepEqual(listed.warnings(), []);
});
