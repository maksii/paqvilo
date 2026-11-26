// @test-kind compatibility: an opted-in local provider exposes the documented form endpoint and citation shape.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSimulator } from '../api.mjs';
import { signInHeaders } from '../testing.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';

const siteId = 'c6738dce-7397-4891-aa15-b533711a1500';
const articlePage = 'c6738dce-7397-4891-aa15-b533711a1501';
const alice = 'c6738dce-7397-4891-aa15-b533711a1502';
const other = 'c6738dce-7397-4891-aa15-b533711a1503';
const articleId = 'c6738dce-7397-4891-aa15-b533711a1504';
const otherId = 'c6738dce-7397-4891-aa15-b533711a1505';
const draftId = 'c6738dce-7397-4891-aa15-b533711a1506';
const internalId = 'c6738dce-7397-4891-aa15-b533711a1507';
const viewId = 'c6738dce-7397-4891-aa15-b533711a1508';
const endpoint = '/_api/search/v1.0/summary';

function article(knowledgearticleid, title, content, x_owner, statecode = 3, isinternal = false) {
  return { knowledgearticleid, title, content, x_owner, statecode, isinternal, x_unshared: 'unshared text' };
}

async function site(t, { visibility = 'public', configured = true, blockedPage = false } = {}) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-search-summary-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const columns = {
    knowledgearticleid: 'primarykey',
    title: 'nvarchar',
    content: 'ntext',
    x_unshared: 'ntext',
  };
  const attributes = Object.entries(columns).map(
    ([name, type]) => `<attribute PhysicalName="${name}"><Name>${name}</Name><Type>${type}</Type></attribute>`,
  );
  const files = {
    'portal/website.yml': `adx_websiteid: ${siteId}\nadx_name: Invented summary`,
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: article',
    'portal/Article.webpage.yml': `adx_webpageid: ${articlePage}\nadx_name: Article\nadx_partialurl: article\nadx_parentpageid: home\nadx_pagetemplateid: article`,
    'portal/Article.pagetemplate.yml': 'adx_pagetemplateid: article\nadx_webtemplateid: article',
    'portal/Article.webtemplate.yml': 'adx_webtemplateid: article\nadx_name: Article',
    'portal/Article.webtemplate.source.html': '<main>Invented article fixture</main>',
    'portal/webrole.yml':
      '- adx_webroleid: member\n  adx_name: Member\n- adx_webroleid: anonymous\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true',
    'portal/sitemarker.yml': `- adx_sitemarkerid: marker\n  adx_name: Knowledge Article\n  adx_pageid: ${articlePage}`,
    ...(blockedPage
      ? {
          'portal/webpageaccesscontrolrule.yml': `- adx_webpageaccesscontrolruleid: restricted\n  adx_webpageid: ${articlePage}\n  adx_right: 2\n  adx_scope: 1\n  adx_webpageaccesscontrolrule_webrole:\n  - member`,
        }
      : {}),
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedSummary</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/knowledgearticle/Entity.xml': `<Entity><Name>knowledgearticle</Name><EntityInfo><entity Name="knowledgearticle"><EntitySetName>knowledgearticles</EntitySetName><PrimaryIdAttribute>knowledgearticleid</PrimaryIdAttribute><PrimaryNameAttribute>title</PrimaryNameAttribute><attributes>${attributes.join('')}</attributes></entity></EntityInfo></Entity>`,
    'solution/Entities/knowledgearticle/SavedQueries/search.xml': `<savedquery><savedqueryid>{${viewId}}</savedqueryid><querytype>0</querytype><LocalizedNames><LocalizedName description="Portal Search" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="knowledgearticle"><attribute name="title"/><attribute name="content"/><attribute name="x_unshared"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="title" width="100"/><cell name="content" width="100"/></row></grid></layoutxml></savedquery>`,
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
      if (input.query.includes('forged')) return { summary: 'forged', citationIds: [internalId] };
      if (input.query.includes('inline'))
        return { summary: '[[1]](https://example.invalid/) <b>ordinary text</b>', citationIds: [] };
      return { summary: input.sources[0].content, citationIds: [input.sources[0].id] };
    },
  };
  const sim = await createSimulator({
    sourceDir: path.join(dir, 'portal'),
    solutionRoots: [path.join(dir, 'solution')],
    packs: configured ? [summaryPack] : [],
    port: 0,
    watch: false,
    initial: {
      version: 1,
      tables: {
        contact: [
          { contactid: alice, fullname: 'Invented Alice' },
          { contactid: other, fullname: 'Invented Other' },
        ],
        knowledgearticle: [
          article(articleId, 'Lantern instructions', 'Adjust the lantern.', alice),
          article(otherId, 'Lantern maintenance', 'Other contact instructions.', other),
          article(draftId, 'Lantern draft', 'Draft instructions.', alice, 0),
          article(internalId, 'Lantern internal', 'Internal instructions.', alice, 3, true),
        ],
      },
      permissions: [
        visibility === 'public'
          ? { entity: 'knowledgearticle', scope: 'global', roles: ['Anonymous Users'], operations: ['read'] }
          : { entity: 'knowledgearticle', scope: 'contact', field: 'x_owner', roles: ['Member'], operations: ['read'] },
      ],
      settings: { permissionMode: 'enforce' },
      simulator: {
        mode: 'local',
        permissionSource: 'configured',
        ...(visibility === 'member' ? { identityScope: 'configured', identity: { id: alice, roles: ['Member'] } } : {}),
      },
    },
  });
  ownedFixture(t).add(() => sim.close());
  const tokenHtml = await (await fetch(`${sim.url}/_layout/tokenhtml`)).text();
  const token = /value="([^"]+)"/.exec(tokenHtml)[1];
  function request({ method = 'POST', body = new URLSearchParams({ userQuery: 'lantern' }), headers = {} } = {}) {
    return fetch(`${sim.url}${endpoint}`, {
      method,
      body: method === 'POST' ? body : undefined,
      headers: { origin: sim.url, __requestverificationtoken: token, ...headers },
    });
  }
  return { sim, request, calls };
}

test('configured local search summary responds with numbered citations for published public articles', async (t) => {
  const { sim, calls, request } = await site(t);
  const res = await request();
  assert.equal(res.status, 200, await res.clone().text());
  const href = `${sim.url}/article/?id=${articleId}`;
  assert.deepEqual(await res.json(), { Summary: `Adjust the lantern. [[1]](${href})`, Citations: { '[1]': href } });
  assert.deepEqual(calls, [
    {
      query: 'lantern',
      sources: [
        { id: articleId, title: 'Lantern instructions', content: 'Adjust the lantern.' },
        { id: otherId, title: 'Lantern maintenance', content: 'Other contact instructions.' },
      ],
    },
  ]);
});

// @test-kind security: the route demands same-origin form admission and a portal token before a provider can see results.
test('request validation does not invoke the configured provider', async (t) => {
  const { request, calls } = await site(t);
  const statuses = [
    [{ method: 'GET' }, 405],
    [{ headers: { origin: 'http://localhost:9999' } }, 403],
    [{ headers: { __requestverificationtoken: 'invalid' } }, 403],
    [{ headers: { 'content-type': 'application/json' }, body: '{"userQuery":"lantern"}' }, 400],
    [
      {
        body: new URLSearchParams([
          ['userQuery', 'lantern'],
          ['userQuery', 'second'],
        ]),
      },
      400,
    ],
    [{ body: new URLSearchParams({ userQuery: '' }) }, 400],
    [{ body: new URLSearchParams({ userQuery: 'a'.repeat(1025) }) }, 400],
    [{ body: new URLSearchParams({ userQuery: 'a'.repeat(17 * 1024) }) }, 413],
  ];
  for (const [options, expected] of statuses) {
    const response = await request(options);
    assert.equal(response.status, expected, await response.text());
  }
  assert.deepEqual(calls, []);
});

// @test-kind security: missing portal sessions cannot fall back to configured identity, and providers cannot forge citations.
test('only the signed in contact can summarize its own article', async (t) => {
  const { sim, request, calls } = await site(t, { visibility: 'member' });
  assert.deepEqual(await (await request()).json(), { Summary: '', Citations: {} });
  assert.deepEqual(calls, []);

  const headers = signInHeaders(sim, alice, { roles: ['Member'] });
  const res = await request({ headers });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(calls[0].sources, [
    { id: articleId, title: 'Lantern instructions', content: 'Adjust the lantern.' },
  ]);
  const forged = await request({ headers, body: new URLSearchParams({ userQuery: 'lantern forged' }) });
  assert.equal(forged.status, 500);
  assert.doesNotMatch(await forged.text(), new RegExp(internalId));
  const inline = await request({ headers, body: new URLSearchParams({ userQuery: 'lantern inline' }) });
  const answer = await inline.json();
  assert.deepEqual(answer.Citations, {});
  assert.doesNotMatch(answer.Summary, /\[\[|<b>/);
});

// @test-kind security: a row with a restricted citation page supplies no provider input for an anonymous visitor.
test('public rows with an unreadable citation page are omitted', async (t) => {
  const { sim, request, calls } = await site(t, { blockedPage: true });
  const article = await fetch(`${sim.url}/article/?id=${articleId}`, { redirect: 'manual' });
  assert.notEqual(article.status, 200);
  assert.deepEqual(await (await request()).json(), { Summary: '', Citations: {} });
  assert.deepEqual(calls, []);
});

test('the default portal dispatch is preserved when the provider is absent', async (t) => {
  const { request } = await site(t, { configured: false });
  const res = await request();
  assert.equal(res.status, 404);
});
