// @test-kind observation: hosted session F3 (paqvilo-developer hosted-f3 summary-F3.md API-05d, ai-xrw-anon, ai-xrw-signed and ai-datasum captures of runs a and b, 2026-11-27): the Search Summary API cites the web pages the search finds as [[n]](page url), answers the captured keys and titles, a miss with ErrorMessage and "No relevant chunks found in dataverse.", an empty body with 500 and the same keys, and /summarystream with text/event-stream partial messages
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSimulator } from '../api.mjs';
import { signInHeaders } from '../testing.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';
import { browserToken } from './support/browser-request-token.mjs';

const siteId = 'c6738dce-7397-4891-aa15-b533711a1500';
const guidePage = 'c6738dce-7397-4891-aa15-b533711a1501';
const alice = 'c6738dce-7397-4891-aa15-b533711a1502';
const cataloguePage = 'c6738dce-7397-4891-aa15-b533711a1503';
const memberPage = 'c6738dce-7397-4891-aa15-b533711a1504';
const draftPage = 'c6738dce-7397-4891-aa15-b533711a1505';
const draftState = 'c6738dce-7397-4891-aa15-b533711a1506';
const otherPage = 'c6738dce-7397-4891-aa15-b533711a1507';
const viewId = 'c6738dce-7397-4891-aa15-b533711a1508';
const articlePage = 'c6738dce-7397-4891-aa15-b533711a1509';
const articleId = 'c6738dce-7397-4891-aa15-b533711a1510';
const otherArticleId = 'c6738dce-7397-4891-aa15-b533711a1511';
const draftArticleId = 'c6738dce-7397-4891-aa15-b533711a1512';
const internalArticleId = 'c6738dce-7397-4891-aa15-b533711a1513';
const articleViewId = 'c6738dce-7397-4891-aa15-b533711a1514';
const other = 'c6738dce-7397-4891-aa15-b533711a1515';
const endpoint = '/_api/search/v1.0/summary';
const SORRY = "I'm sorry, I'm unable to process your question. Can you rephrase or ask another question?";

const page = (id, name, url, copy, extra = '') =>
  `adx_webpageid: ${id}\nadx_name: ${name}\nadx_partialurl: ${url}\nadx_parentpageid: home\nadx_pagetemplateid: main\nadx_copy: "${copy}"${extra}`;

const article = (knowledgearticleid, title, content, x_owner, statecode = 3, isinternal = false) => ({
  knowledgearticleid,
  title,
  content,
  x_owner,
  statecode,
  isinternal,
  x_unshared: 'unshared text',
});
// Knowledge articles indexed by a Portal Search view, shown on the Knowledge Article page (the site marker) with the
// article id in `id`; `articles` is the read permission: "public" (Anonymous Users) or "member" (the owner contact).
const articleFiles = (blockedArticlePage) => {
  const columns = { knowledgearticleid: 'primarykey', title: 'nvarchar', content: 'ntext', x_unshared: 'ntext' };
  const attributes = Object.entries(columns)
    .map(([name, type]) => `<attribute PhysicalName="${name}"><Name>${name}</Name><Type>${type}</Type></attribute>`)
    .join('');
  return {
    'portal/Article.webpage.yml': `adx_webpageid: ${articlePage}\nadx_name: Article\nadx_partialurl: article\nadx_parentpageid: home\nadx_pagetemplateid: main\nadx_copy: "Article page"`,
    'portal/sitemarker.yml': `- adx_sitemarkerid: marker\n  adx_name: Knowledge Article\n  adx_pageid: ${articlePage}`,
    ...(blockedArticlePage
      ? {
          'portal/webpageaccesscontrolrule.yml': [memberPage, articlePage]
            .map(
              (id) =>
                `- adx_webpageaccesscontrolruleid: rule-${id}\n  adx_webpageid: ${id}\n  adx_right: 2\n  adx_scope: 1\n  adx_webpageaccesscontrolrule_webrole:\n  - member`,
            )
            .join('\n'),
        }
      : {}),
    'solution/Entities/knowledgearticle/Entity.xml': `<Entity><Name>knowledgearticle</Name><EntityInfo><entity Name="knowledgearticle"><EntitySetName>knowledgearticles</EntitySetName><PrimaryIdAttribute>knowledgearticleid</PrimaryIdAttribute><PrimaryNameAttribute>title</PrimaryNameAttribute><attributes>${attributes}</attributes></entity></EntityInfo></Entity>`,
    'solution/Entities/knowledgearticle/SavedQueries/search.xml': `<savedquery><savedqueryid>{${articleViewId}}</savedqueryid><querytype>0</querytype><LocalizedNames><LocalizedName description="Portal Search" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="knowledgearticle"><attribute name="title"/><attribute name="content"/><attribute name="x_unshared"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="title" width="100"/><cell name="content" width="100"/></row></grid></layoutxml></savedquery>`,
  };
};
const articlePermission = (articles) =>
  articles === 'public'
    ? { entity: 'knowledgearticle', scope: 'global', roles: ['Anonymous Users'], operations: ['read'] }
    : { entity: 'knowledgearticle', scope: 'contact', field: 'x_owner', roles: ['Member'], operations: ['read'] };

async function site(
  t,
  {
    configured = true,
    configuredMember = false,
    articles = null,
    blockedArticlePage = false,
    observed,
    extraArticles = [],
  } = {},
) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-search-summary-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const attributes = ['adx_name', 'adx_copy']
    .map((name) => `<attribute PhysicalName="${name}"><Name>${name}</Name><Type>ntext</Type></attribute>`)
    .join('');
  const files = {
    'portal/website.yml': `adx_websiteid: ${siteId}\nadx_name: Invented summary`,
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Guide.webpage.yml': page(guidePage, 'Invented lantern guide', 'guide', '<p>Light the lantern slowly.</p>'),
    'portal/Catalogue.webpage.yml': page(
      cataloguePage,
      'Invented lanterns catalogue',
      'catalogue',
      '<p>Many lanterns.</p>',
    ),
    'portal/Member.webpage.yml': page(memberPage, 'Invented member lantern', 'member', '<p>Member lantern notes.</p>'),
    'portal/Draft.webpage.yml': page(
      draftPage,
      'Invented draft lantern',
      'draft',
      '<p>Unreleased lantern.</p>',
      `\nadx_publishingstateid: ${draftState}`,
    ),
    'portal/Other.webpage.yml': page(otherPage, 'Invented anchor', 'anchor', '<p>Heavy anchor.</p>'),
    'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html': '<main>{{ page.adx_copy }}</main>',
    'portal/publishingstate.yml': `- adx_publishingstateid: ${draftState}\n  adx_name: Draft\n  adx_isvisible: false`,
    'portal/webrole.yml':
      '- adx_webroleid: member\n  adx_name: Member\n- adx_webroleid: anonymous\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true',
    'portal/webpageaccesscontrolrule.yml': `- adx_webpageaccesscontrolruleid: restricted\n  adx_webpageid: ${memberPage}\n  adx_right: 2\n  adx_scope: 1\n  adx_webpageaccesscontrolrule_webrole:\n  - member`,
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedSummary</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/adx_webpage/Entity.xml': `<Entity><Name>adx_webpage</Name><EntityInfo><entity Name="adx_webpage"><EntitySetName>adx_webpages</EntitySetName><PrimaryIdAttribute>adx_webpageid</PrimaryIdAttribute><PrimaryNameAttribute>adx_name</PrimaryNameAttribute><attributes><attribute PhysicalName="adx_webpageid"><Name>adx_webpageid</Name><Type>primarykey</Type></attribute>${attributes}</attributes></entity></EntityInfo></Entity>`,
    'solution/Entities/adx_webpage/SavedQueries/search.xml': `<savedquery><savedqueryid>{${viewId}}</savedqueryid><querytype>0</querytype><LocalizedNames><LocalizedName description="Portal Search" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="adx_webpage"><attribute name="adx_name"/><attribute name="adx_copy"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="adx_name" width="100"/><cell name="adx_copy" width="100"/></row></grid></layoutxml></savedquery>`,
    ...(articles ? articleFiles(blockedArticlePage) : {}),
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const calls = [];
  const summaryPack = {
    id: 'invented-summary',
    name: 'Invented summary fixture',
    description: 'Invented local provider for search summary tests',
    matches: () => true,
    presets: () => ({}),
    portalSearchSummary(input) {
      calls.push(input);
      if (input.query.includes('forged')) return { summary: 'forged', citationIds: [memberPage, internalArticleId] };
      if (input.query.includes('inline'))
        return { summary: '[[1]](https://example.invalid/) <b>ordinary text</b>', citationIds: [] };
      if (input.query.includes('silent')) return { summary: '', citationIds: [] };
      return { summary: 'Lanterns are described.', citationIds: input.sources.map((source) => source.id) };
    },
  };
  const sim = await createSimulator({
    sourceDir: path.join(dir, 'portal'),
    solutionRoots: [path.join(dir, 'solution')],
    packs: configured ? [summaryPack] : [],
    ...(observed ? { observed } : {}),
    port: 0,
    watch: false,
    initial: {
      version: 1,
      mappings: { adx_webpage: { entitySet: 'adx_webpages', idColumn: 'adx_webpageid', nameColumn: 'adx_name' } },
      tables: {
        contact: [
          { contactid: alice, fullname: 'Invented Alice' },
          { contactid: other, fullname: 'Invented Other' },
        ],
        ...(articles
          ? {
              knowledgearticle: [
                article(articleId, 'Lantern instructions', 'Adjust the lantern.', alice),
                article(otherArticleId, 'Lantern maintenance', 'Other contact instructions.', other),
                article(draftArticleId, 'Lantern draft', 'Draft instructions.', alice, 0),
                article(internalArticleId, 'Lantern internal', 'Internal instructions.', alice, 3, true),
                ...extraArticles,
              ],
            }
          : {}),
      },
      // No adx_webpage table permission: web page access rules govern pages in search (hosted session F3).
      permissions: articles ? [articlePermission(articles)] : [],
      settings: { permissionMode: 'enforce' },
      simulator: {
        mode: 'local',
        permissionSource: 'configured',
        ...(configuredMember ? { identityScope: 'configured', identity: { id: alice, roles: ['Member'] } } : {}),
      },
    },
  });
  ownedFixture(t).add(() => sim.close());
  async function request({
    method = 'POST',
    target = endpoint,
    body = new URLSearchParams({ userQuery: 'lantern' }),
    headers = {},
  } = {}) {
    const browser = await browserToken(sim, headers);
    return fetch(`${sim.url}${target}`, {
      method,
      body: method === 'POST' ? body : undefined,
      // The hosted client sends X-Requested-With; without it the API refuses (see the observation test below).
      headers: {
        origin: sim.url,
        'x-requested-with': 'XMLHttpRequest',
        __requestverificationtoken: browser.token,
        ...headers,
        cookie: browser.cookie,
      },
    });
  }
  return { sim, request, calls };
}

const keys = [
  'Summary',
  'SummaryTitle',
  'SearchTitle',
  'ErrorMessage',
  'ResponseStatus',
  'Citations',
  'CitationTitleMapping',
  'Chunks',
];

test('the search summary cites the web pages the visitor search finds', async (t) => {
  const { sim, calls, request } = await site(t);
  const res = await request();
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(res.headers.get('cache-control'), 'private');
  const body = await res.json();
  assert.deepEqual(Object.keys(body), keys);
  const cited = calls[0].sources.map((source) => source.id);
  const urls = cited.map((id) => `${sim.url}/${id === guidePage ? 'guide' : 'catalogue'}/`);
  assert.deepEqual(cited.toSorted(), [guidePage, cataloguePage].toSorted(), 'the member and draft pages are not read');
  const citations = Object.fromEntries(urls.map((url, index) => [`[${index + 1}]`, url]));
  assert.deepEqual(body, {
    Summary: `Lanterns are described. ${urls.map((url, index) => `[[${index + 1}]](${url})`).join('')}`,
    SummaryTitle: 'Summarized by AI',
    SearchTitle: 'Other results',
    ErrorMessage: null,
    ResponseStatus: { Code: 200, Message: 'Success' },
    Citations: citations,
    CitationTitleMapping: citations,
    Chunks: null,
  });
  assert.deepEqual(
    calls[0].sources.find((source) => source.id === guidePage),
    { id: guidePage, title: 'Invented lantern guide', content: 'Light the lantern slowly.' },
  );
  const json = await request({
    body: JSON.stringify({ userQuery: 'lantern' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(json.status, 200, 'a JSON userQuery is accepted');
  assert.equal((await json.json()).ResponseStatus.Message, 'Success');
});

test('a miss, a silent provider and an empty body answer the captured shapes', async (t) => {
  const { request, calls } = await site(t);
  const miss = await request({ body: new URLSearchParams({ userQuery: 'zzqqxx nothing matches' }) });
  assert.equal(miss.status, 200);
  assert.deepEqual(await miss.json(), {
    Summary: null,
    SummaryTitle: 'Summarized by AI',
    SearchTitle: 'Other results',
    ErrorMessage: SORRY,
    ResponseStatus: { Code: 200, Message: 'No relevant chunks found in dataverse.' },
    Citations: null,
    CitationTitleMapping: null,
    Chunks: null,
  });
  assert.equal(calls.length, 0, 'no source, no provider call');
  const silent = await request({ body: new URLSearchParams({ userQuery: 'lantern silent' }) });
  assert.deepEqual((await silent.json()).ResponseStatus, { Code: 200, Message: 'No relevant responses were found.' });
  const empty = await request({ body: '', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(empty.status, 500);
  assert.deepEqual(await empty.json(), {
    Summary: null,
    SummaryTitle: 'Summarized by AI',
    SearchTitle: 'Other results',
    ErrorMessage: SORRY,
    ResponseStatus: { Code: 500, Message: SORRY },
    Citations: null,
    CitationTitleMapping: null,
    Chunks: null,
  });
  assert.equal(calls.length, 1);
  const missing = await request({ method: 'GET', target: `${endpoint}?userQuery=lantern` });
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), '');
});

test('summarystream answers the summary as text/event-stream partial messages', async (t) => {
  const { sim, request } = await site(t);
  const res = await request({
    target: '/_api/search/v1.0/summarystream',
    body: JSON.stringify({ UserQuery: 'lantern', KeyWords: 'lantern' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const events = (await res.text())
    .split('\n\n')
    .filter(Boolean)
    .map((event) => {
      assert.match(event, /^data: /);
      return JSON.parse(event.slice('data: '.length));
    });
  assert.ok(events.length > 1);
  assert.deepEqual(Object.keys(events[0]), keys);
  assert.deepEqual([events[0].SummaryTitle, events[0].SearchTitle], ['Summarized by AI', 'Other results']);
  assert.deepEqual([events[1].SummaryTitle, events[1].SearchTitle], [null, null]);
  assert.ok(events.every((event) => event.ResponseStatus.Message === 'Partial Message'));
  const text = events.map((event) => event.Summary).join('');
  assert.ok(text.startsWith('Lanterns are described. [[1]]('));
  assert.match(text, new RegExp(`\\]\\(${sim.url}/(?:guide|catalogue)/\\)`));
});

// @test-kind observation: hosted session F3 (summary-F3.md API-05d, ai-base, ai-admin and ai-xrw captures of runs a and b): without X-Requested-With an anonymous request answers the platform's 500 error page and a signed-in one 401; with it, a request without a token answers 401; nothing reaches the provider
test('the request filters refuse before the provider as the hosted API does', async (t) => {
  const { sim, request, calls } = await site(t);
  const anonymous = await request({ headers: { 'x-requested-with': '' } });
  assert.equal(anonymous.status, 500);
  assert.match(anonymous.headers.get('content-type'), /^text\/html/);
  assert.match(await anonymous.text(), /<title>We&#39;re sorry, but something went wrong \(500\)<\/title>/);
  const signedIn = await request({
    headers: { ...signInHeaders(sim, alice, { roles: ['Member'] }), 'x-requested-with': '' },
  });
  assert.equal(signedIn.status, 401);
  assert.equal(await signedIn.text(), '');
  const tokenless = await request({ headers: { __requestverificationtoken: '' } });
  assert.equal(tokenless.status, 401);
  assert.deepEqual(calls, []);
});

// @test-kind security: the route demands same-origin admission, a valid portal token and bounded input before a provider can see results.
test('request validation does not invoke the configured provider', async (t) => {
  const { request, calls } = await site(t);
  const statuses = [
    [{ headers: { origin: 'http://localhost:9999' } }, 403],
    [{ headers: { __requestverificationtoken: 'invalid' } }, 403],
    [{ headers: { 'content-type': 'text/plain' }, body: 'userQuery=lantern' }, 400],
    [
      {
        body: new URLSearchParams([
          ['userQuery', 'lantern'],
          ['userQuery', 'second'],
        ]),
      },
      400,
    ],
    [{ body: new URLSearchParams({ userQuery: '' }) }, 500],
    [{ body: new URLSearchParams({ userQuery: 'a'.repeat(1025) }) }, 400],
    [{ body: new URLSearchParams({ userQuery: 'a'.repeat(17 * 1024) }) }, 413],
  ];
  for (const [options, expected] of statuses) {
    const response = await request(options);
    assert.equal(response.status, expected, await response.text());
  }
  assert.deepEqual(calls, []);
});

// @test-kind security: a page the visitor may not read, or one in a non-visible publishing state, supplies no provider input, and providers cannot forge citations.
test('only readable published pages reach the provider and citations cannot be forged', async (t) => {
  const { sim, request, calls } = await site(t);
  const restricted = await fetch(`${sim.url}/member/`, { redirect: 'manual' });
  assert.notEqual(restricted.status, 200);
  await request({ body: new URLSearchParams({ userQuery: 'member' }) });
  assert.deepEqual(calls, [], 'the restricted page is no anonymous source');
  await request({ body: new URLSearchParams({ userQuery: 'unreleased' }) });
  assert.deepEqual(calls, [], 'the draft page is no source');
  const headers = signInHeaders(sim, alice, { roles: ['Member'] });
  const member = await request({ headers, body: new URLSearchParams({ userQuery: 'member' }) });
  assert.equal(member.status, 200, await member.clone().text());
  assert.deepEqual(
    calls[0].sources.map((source) => source.id),
    [memberPage],
  );
  const forged = await request({ body: new URLSearchParams({ userQuery: 'lantern forged' }) });
  assert.equal(forged.status, 500);
  assert.doesNotMatch(await forged.text(), new RegExp(memberPage));
  const inline = await request({ headers, body: new URLSearchParams({ userQuery: 'lantern inline' }) });
  const answer = await inline.json();
  assert.equal(answer.Citations, null);
  assert.doesNotMatch(answer.Summary, /\[\[|<b>/);
});

// @test-kind security: a request without a portal session never falls back to the configured identity
test('a signed-out request reads as the anonymous visitor, not the configured identity', async (t) => {
  const { request, calls } = await site(t, { configuredMember: true });
  await request({ body: new URLSearchParams({ userQuery: 'member' }) });
  assert.deepEqual(calls, [], 'the member-only page is no source without a session');
});

// @test-kind compatibility: without a registered provider the summary route keeps ordinary portal dispatch
test('the default portal dispatch is preserved when the provider is absent', async (t) => {
  const { request } = await site(t, { configured: false });
  const res = await request();
  assert.equal(res.status, 404);
});

// @test-kind observation: hosted session F3 (summary-F3.md API-05d, ai-xrw-anon, ai-xrw-signed, ai-datasum-anon and ai-datasum-signed captures of runs a and b): an anonymous visitor's summary answers (200 and the 500 of an empty body) send Cache-Control private, a signed-in visitor's send no-cache, no-store, must-revalidate with Expires -1, and /summarystream sends private to both
test('the summary answers carry the captured caching headers per visitor', async (t) => {
  const { sim, request } = await site(t);
  const caching = (res) => [res.status, res.headers.get('cache-control'), res.headers.get('expires')];
  const emptyBody = { body: '', headers: { 'content-type': 'application/x-www-form-urlencoded' } };
  const stream = {
    target: '/_api/search/v1.0/summarystream',
    body: JSON.stringify({ UserQuery: 'lantern' }),
    headers: { 'content-type': 'application/json' },
  };
  assert.deepEqual(caching(await request()), [200, 'private', null]);
  assert.deepEqual(caching(await request(emptyBody)), [500, 'private', null]);
  assert.deepEqual(caching(await request(stream)), [200, 'private', null]);
  const signedIn = signInHeaders(sim, alice, { roles: ['Member'] });
  const noStore = 'no-cache, no-store, must-revalidate';
  assert.deepEqual(caching(await request({ headers: signedIn })), [200, noStore, '-1']);
  assert.deepEqual(caching(await request({ ...emptyBody, headers: { ...emptyBody.headers, ...signedIn } })), [
    500,
    noStore,
    '-1',
  ]);
  assert.deepEqual(caching(await request({ ...stream, headers: { ...stream.headers, ...signedIn } })), [
    200,
    'private',
    null,
  ]);
});

// @test-kind compatibility: Learn power-pages/configure/search/generative-ai ("The same content is used by both generative AI search and keyword search"; a table's citation page must use 'id' as the query string parameter): a published, non-internal knowledge article the visitor's search finds is a source cited by the Knowledge Article page with its id
test('a readable published article the search finds is a source cited by its article page', async (t) => {
  const { sim, request, calls } = await site(t, { articles: 'public' });
  const res = await request({ body: new URLSearchParams({ userQuery: 'lantern' }) });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(
    calls[0].sources.map((source) => source.id).toSorted(),
    [guidePage, cataloguePage, articleId, otherArticleId].toSorted(),
    'the draft and internal articles are not sources',
  );
  assert.deepEqual(
    calls[0].sources.find((source) => source.id === articleId),
    { id: articleId, title: 'Lantern instructions', content: 'Adjust the lantern.' },
    'only the indexed content reaches the provider',
  );
  assert.ok(Object.values((await res.json()).Citations).includes(`${sim.url}/article/?id=${articleId}`));
});

// @test-kind contract: a knowledge article row without a title (the column is optional in an invented row) is still a source, with an empty title, instead of failing the summary
test('an article without a title is a source with an empty title', async (t) => {
  const untitledId = 'c6738dce-7397-4891-aa15-b533711a1519';
  const untitled = article(untitledId, null, 'Trim the wick.', alice);
  const { request, calls } = await site(t, { articles: 'public', extraArticles: [untitled] });
  const res = await request({ body: new URLSearchParams({ userQuery: 'wick' }) });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(calls[0].sources, [{ id: untitledId, title: '', content: 'Trim the wick.' }]);
});

// @test-kind security: a knowledge article reaches the provider only through the visitor's table permission: without a session no member article is a source, a signed-in contact reads only its own article, and a provider cannot cite an article it was not given
test('only the signed-in owner of an article can summarize it', async (t) => {
  const { sim, request, calls } = await site(t, { articles: 'member' });
  const anonymous = await request({ body: new URLSearchParams({ userQuery: 'instructions' }) });
  assert.equal((await anonymous.json()).ResponseStatus.Message, 'No relevant chunks found in dataverse.');
  assert.deepEqual(calls, []);
  const headers = signInHeaders(sim, alice, { roles: ['Member'] });
  const res = await request({ headers, body: new URLSearchParams({ userQuery: 'instructions' }) });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(calls[0].sources, [
    { id: articleId, title: 'Lantern instructions', content: 'Adjust the lantern.' },
  ]);
  const forged = await request({ headers, body: new URLSearchParams({ userQuery: 'instructions forged' }) });
  assert.equal(forged.status, 500);
  assert.doesNotMatch(await forged.text(), new RegExp(internalArticleId));
});

// @test-kind security: a readable article whose Knowledge Article page the visitor may not open supplies no provider input
test('an article with an unreadable citation page is no source', async (t) => {
  const query = () => new URLSearchParams({ userQuery: 'instructions' });
  // Control: the same article, with its Knowledge Article page readable, is a source.
  const readable = await site(t, { articles: 'public' });
  const open = await fetch(`${readable.sim.url}/article/?id=${articleId}`, { redirect: 'manual' });
  assert.equal(open.status, 200);
  assert.equal((await readable.request({ body: query() })).status, 200);
  assert.ok(
    readable.calls[0]?.sources.some((source) => source.id === articleId),
    'the article with a readable citation page reaches the provider',
  );
  // The only difference: a web page access rule makes the citation page unreadable for this visitor.
  const { sim, request, calls } = await site(t, { articles: 'public', blockedArticlePage: true });
  const page = await fetch(`${sim.url}/article/?id=${articleId}`, { redirect: 'manual' });
  assert.notEqual(page.status, 200);
  await request({ body: query() });
  assert.deepEqual(calls, []);
});

// @test-kind security: a web page in a non-visible publishing state is no summary source for a visitor who cannot preview it by default, and Mirage warns what a hosted site with Dataverse search lists (F3 PAGE-04f)
test('a draft page is no summary source by default and the exclusion is reported', async (t) => {
  const { sim, request, calls } = await site(t);
  await request({ body: new URLSearchParams({ userQuery: 'unreleased' }) });
  assert.deepEqual(calls, []);
  const warning = sim.state().diagnostics.find((item) => item.code === 'PORTAL_SEARCH_UNPUBLISHED_PAGES_EXCLUDED');
  assert.equal(warning?.severity, 'warning');
  assert.match(warning.message, /observed\.searchUnpublishedPages/);
});

// @test-kind unproven: hosted session F3 (summary-F3.md PAGE-04f) captured search results listing draft pages to anonymous visitors, not a summary citing one; observed.searchUnpublishedPages listed applies the same rule to the summary sources, which the hosted summary draws from the same index, and never lifts a page's access rules
test('observed.searchUnpublishedPages listed makes a draft page a summary source', async (t) => {
  const { request, calls } = await site(t, {
    observed: { searchUnpublishedPages: 'listed', evidence: 'Invented loopback observation' },
  });
  await request({ body: new URLSearchParams({ userQuery: 'unreleased' }) });
  assert.deepEqual(
    calls[0].sources.map((source) => source.id),
    [draftPage],
  );
  await request({ body: new URLSearchParams({ userQuery: 'member' }) });
  assert.equal(calls.length, 1, 'the restricted page stays out');
});
