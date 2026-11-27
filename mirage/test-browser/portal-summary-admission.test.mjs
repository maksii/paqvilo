// @test-kind security+contract: local summary routes use the real browser session token and pass only admitted data to trusted packs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sharedBrowser } from './shared-browser.mjs';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';

const browser = sharedBrowser({ headless: true });
const actor = '80000000-0000-4000-8000-000000000001';
const record = '80000000-0000-4000-8000-000000000002';
const related = '80000000-0000-4000-8000-000000000003';
const site = '80000000-0000-4000-8000-000000000004';
const view = '80000000-0000-4000-8000-000000000005';
const hidden = '80000000-0000-4000-8000-000000000006';
const relatedArticle = '80000000-0000-4000-8000-000000000007';
const hiddenArticle = '80000000-0000-4000-8000-000000000008';
const articleView = '80000000-0000-4000-8000-000000000009';
const dataEndpoint = '/_api/summarization/data/v1.0/sample_records(' + record + ')?$select=title';
const searchEndpoint = '/_api/search/v1.0/summary';
const prompt = 'Summarization/prompt/sample';

test('both local summary routes use the paired token of a real browser and receive only admitted data', async (t) => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-summary-browser-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'portal/website.yml': 'adx_websiteid: ' + site + '\nadx_name: Invented',
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: basic',
    'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: basic\nadx_webtemplateid: main',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html': '<main>Invented browser summary fixture</main>',
    // Search summary sources are the web pages and knowledge articles the visitor's search finds. Pages: one the reader
    // may read and one restricted to a role neither visitor holds (web page access control rules govern them). Articles:
    // one owned by the reader and one by another contact (a contact-scoped table permission governs them).
    'portal/Lanternhelp.webpage.yml':
      'adx_webpageid: ' +
      related +
      '\nadx_name: Lantern help\nadx_partialurl: help\nadx_parentpageid: home\nadx_pagetemplateid: basic\nadx_copy: One admitted page.',
    'portal/Lanterninventory.webpage.yml':
      'adx_webpageid: ' +
      hidden +
      '\nadx_name: Lantern inventory\nadx_partialurl: inventory\nadx_parentpageid: home\nadx_pagetemplateid: basic\nadx_copy: Another restricted page.',
    'portal/webrole.yml':
      '- adx_webroleid: reader\n  adx_name: Reader\n- adx_webroleid: editor\n  adx_name: Editor\n- adx_webroleid: anonymous\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true',
    'portal/webpageaccesscontrolrule.yml': [
      [related, 'reader'],
      [hidden, 'editor'],
    ]
      .map(
        ([id, role]) =>
          '- adx_webpageaccesscontrolruleid: rule-' +
          role +
          '\n  adx_webpageid: ' +
          id +
          '\n  adx_right: 2\n  adx_scope: 1\n  adx_webpageaccesscontrolrule_webrole:\n  - ' +
          role,
      )
      .join('\n'),
    'portal/sitemarker.yml': '- adx_sitemarkerid: lookup\n  adx_name: Knowledge Article\n  adx_pageid: home',
    'portal/sitesetting.yml': [
      'Webapi/sample_record/enabled: true',
      'Webapi/sample_record/fields: title',
      'Summarization/Data/Enable: true',
      prompt + ': Summarize the selected record.',
    ]
      .map((line, index) => {
        const [name, value] = line.split(': ');
        return '- adx_sitesettingid: setting-' + index + '\n  adx_name: ' + name + '\n  adx_value: "' + value + '"';
      })
      .join('\n'),
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedSummary</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/adx_webpage/Entity.xml':
      '<Entity><Name>adx_webpage</Name><EntityInfo><entity Name="adx_webpage"><EntitySetName>adx_webpages</EntitySetName><PrimaryIdAttribute>adx_webpageid</PrimaryIdAttribute><PrimaryNameAttribute>adx_name</PrimaryNameAttribute><attributes><attribute PhysicalName="adx_name"><Name>adx_name</Name><Type>nvarchar</Type></attribute><attribute PhysicalName="adx_copy"><Name>adx_copy</Name><Type>ntext</Type></attribute></attributes></entity></EntityInfo></Entity>',
    'solution/Entities/adx_webpage/SavedQueries/search.xml':
      '<savedquery><savedqueryid>{' +
      view +
      '}</savedqueryid><querytype>0</querytype><LocalizedNames><LocalizedName description="Portal Search" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="adx_webpage"><attribute name="adx_name"/><attribute name="adx_copy"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="adx_name" width="100"/><cell name="adx_copy" width="100"/></row></grid></layoutxml></savedquery>',
    'solution/Entities/knowledgearticle/Entity.xml':
      '<Entity><Name>knowledgearticle</Name><EntityInfo><entity Name="knowledgearticle"><EntitySetName>knowledgearticles</EntitySetName><PrimaryIdAttribute>knowledgearticleid</PrimaryIdAttribute><PrimaryNameAttribute>title</PrimaryNameAttribute><attributes><attribute PhysicalName="title"><Name>title</Name><Type>nvarchar</Type></attribute><attribute PhysicalName="content"><Name>content</Name><Type>ntext</Type></attribute></attributes></entity></EntityInfo></Entity>',
    'solution/Entities/knowledgearticle/SavedQueries/search.xml':
      '<savedquery><savedqueryid>{' +
      articleView +
      '}</savedqueryid><querytype>0</querytype><LocalizedNames><LocalizedName description="Portal Search" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="knowledgearticle"><attribute name="title"/><attribute name="content"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="title" width="100"/><cell name="content" width="100"/></row></grid></layoutxml></savedquery>',
  };
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }
  const calls = { data: [], search: [] };
  const sim = await createSimulator({
    sourceDir: path.join(dir, 'portal'),
    solutionRoots: [path.join(dir, 'solution')],
    watch: false,
    identityProvider: { pairedBrowserTokens: true },
    initial: {
      settings: { permissionMode: 'enforce' },
      simulator: {
        mode: 'local',
        permissionSource: 'configured',
        contactRoles: [{ contactId: actor, roleId: 'reader' }],
      },
      mappings: {
        sample_record: { entitySet: 'sample_records', idColumn: 'sample_recordid', nameColumn: 'title' },
      },
      tables: {
        contact: [{ contactid: actor, fullname: 'Invented Reader' }],
        sample_record: [{ sample_recordid: record, title: 'Admitted example', x_owner: actor }],
        knowledgearticle: [
          {
            knowledgearticleid: relatedArticle,
            title: 'Lantern article',
            content: 'One admitted article.',
            statecode: 3,
            x_owner: actor,
          },
          {
            knowledgearticleid: hiddenArticle,
            title: 'Lantern stock article',
            content: 'Another contact article.',
            statecode: 3,
            x_owner: hidden,
          },
        ],
      },
      permissions: ['sample_record', 'knowledgearticle'].map((entity) => ({
        id: entity,
        entity,
        scope: 'contact',
        field: 'x_owner',
        roles: ['Reader'],
        operations: ['read'],
      })),
    },
    packs: [
      {
        id: 'browser-summary',
        name: 'Browser summary fixture',
        description: 'Invented browser test data',
        matches: () => true,
        presets: () => ({}),
        portalDataSummary(input) {
          calls.data.push(input.record);
          return { summary: input.record.title };
        },
        portalSearchSummary(input) {
          calls.search.push(input.sources);
          return { summary: input.sources[0].content, citationIds: [input.sources[0].id] };
        },
      },
    ],
  });
  ownedFixture(t).add(() => sim.close());
  const page = await browser.page(t);
  await signInContext(page.context(), sim, actor, { roles: ['Reader'] });
  await page.goto(sim.url);
  const run = (page, foreignToken = null) =>
    page.evaluate(
      async ({ dataEndpoint, searchEndpoint, prompt, foreignToken }) => {
        const holder = new DOMParser().parseFromString(await (await fetch('/_layout/tokenhtml')).text(), 'text/html');
        const token = holder.querySelector('input[name="__RequestVerificationToken"]').value;
        const send = async (route, contentType, body, supplied = token) => {
          const response = await fetch(route, {
            method: 'POST',
            // The portal's own client sends X-Requested-With; the summary API refuses a request without it
            // (hosted session F3, API-05d, runs a and b).
            headers: {
              'content-type': contentType,
              'X-Requested-With': 'XMLHttpRequest',
              __RequestVerificationToken: supplied,
            },
            body,
          });
          return [response.status, await response.json()];
        };
        const json = JSON.stringify({ InstructionIdentifier: prompt });
        return {
          token,
          data: await send(dataEndpoint, 'application/json', json),
          search: await send(searchEndpoint, 'application/x-www-form-urlencoded', 'userQuery=lantern'),
          foreign: foreignToken
            ? [
                (await send(dataEndpoint, 'application/json', json, foreignToken))[0],
                (await send(searchEndpoint, 'application/x-www-form-urlencoded', 'userQuery=lantern', foreignToken))[0],
              ]
            : null,
        };
      },
      { dataEndpoint, searchEndpoint, prompt, foreignToken },
    );
  const signed = await run(page);
  assert.ok(signed.token && signed.token !== sim.portalToken, 'browser token must be separate from the tool token');
  assert.equal(signed.data[0], 200, JSON.stringify(signed.data[1]));
  assert.equal(signed.search[0], 200, JSON.stringify(signed.search[1]));
  assert.deepEqual(calls.data, [{ title: 'Admitted example' }]);
  assert.deepEqual(calls.search[0].map(({ id }) => id).sort(), [related, relatedArticle].sort());

  const guest = await browser.page(t);
  await guest.goto(sim.url);
  const denied = await run(guest, signed.token);
  assert.ok(denied.token && denied.token !== signed.token, 'the two contexts must own different browser tokens');
  assert.equal(denied.data[0], 403, JSON.stringify(denied.data[1]));
  // The guest holds neither page's role nor an article permission: no source, the hosted empty answer, and the
  // provider is not called.
  assert.equal(denied.search[0], 200);
  assert.deepEqual(
    [denied.search[1].Summary, denied.search[1].Citations, denied.search[1].ResponseStatus],
    [null, null, { Code: 200, Message: 'No relevant chunks found in dataverse.' }],
  );
  assert.deepEqual(denied.foreign, [403, 403]);
  assert.equal(calls.data.length, 1);
  assert.equal(calls.search.length, 1);
});
