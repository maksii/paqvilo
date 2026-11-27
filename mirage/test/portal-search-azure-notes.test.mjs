// @test-kind security: a cloud attachment placeholder body (Azure file Web API or form cloud attachment; it names the file's storage key) is never search content; its subject and file name stay searchable
// Learn power-pages/configure/search/file-attachment: with Search/IndexNotesAttachments and KnowledgeManagement/DisplayNotes
// true, knowledge article notes are searched. A `.azure.txt` note (lib/portal-file-api.mjs) and a form attachment stored in
// cloud storage (lib/form-service.mjs) hold { Name, Type, Size, Url } rather than the file, so Mirage indexes their subject,
// note text and file name only (Mirage-own; the platform's handling is not documented). Invented site, article and notes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { DataStore } from '../lib/data.mjs';
import { submitPortalForm } from '../lib/form-service.mjs';
import { createMemoryStorage } from '../lib/storage-memory.mjs';
import { guardProvider } from '../lib/storage-provider.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const id = (n) => `5a5a5a5a-5a5a-45a5-85a5-5a5a5a5a5a${String(n).padStart(2, '0')}`;
const SITE = id(1);
const ARTICLE_PAGE = id(2);
const ARTICLE = id(30);
const base64 = (value) => Buffer.from(value).toString('base64');

const entity = (name, columns, primary) =>
  `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}"><EntitySetName>${name}s</EntitySetName><PrimaryIdAttribute>${name}id</PrimaryIdAttribute><PrimaryNameAttribute>${primary}</PrimaryNameAttribute><attributes><attribute PhysicalName="${name}id"><Name>${name}id</Name><Type>primarykey</Type></attribute>${columns.map((column) => `<attribute PhysicalName="${column}"><Name>${column}</Name><Type>nvarchar</Type><displaynames><displayname description="${column}" languagecode="1033"/></displaynames></attribute>`).join('')}</attributes></entity></EntityInfo></Entity>`;
const view = (table, viewId, columns) =>
  `<savedquery><savedqueryid>{${viewId}}</savedqueryid><querytype>0</querytype><isdefault>0</isdefault><LocalizedNames><LocalizedName description="Portal Search" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="${table}">${columns.map((column) => `<attribute name="${column}"/>`).join('')}</entity></fetch></fetchxml><layoutxml><grid><row>${columns.map((column) => `<cell name="${column}" width="100"/>`).join('')}</row></grid></layoutxml></savedquery>`;

// The note a basic form writes for an attachment stored in cloud storage (FileStorage/CloudStorageAccount set): the real
// writer's output, re-linked to the knowledge article below.
async function formCloudNote() {
  const store = await new DataStore({
    state: {
      mappings: {
        x_request: { entitySet: 'x_requests', idColumn: 'x_requestid' },
        annotation: { entitySet: 'annotations', idColumn: 'annotationid' },
      },
      tables: { x_request: [], annotation: [] },
      settings: { permissionMode: 'permissive' },
      permissions: [],
    },
  }).init();
  const cloud = guardProvider(createMemoryStorage({ id: 'cloud' }));
  await submitPortalForm(
    'entityform',
    'requests',
    {
      values: { x_name: 'Invented' },
      attachments: [{ name: 'Survey.pdf', type: 'application/pdf', content: base64('%PDF survey') }],
    },
    {
      portal: {
        settings: { 'FileStorage/CloudStorageAccount': 'inventedaccount' },
        forms: [{ id: 'requests', mode: 100000000, metadata: { adx_attachfile: true } }],
      },
      store,
      schemas: { requests: { entity: 'x_request', fields: [{ name: 'x_name' }] } },
      identity: { id: id(9), roles: [] },
      cloudAttachments: () => cloud,
    },
  );
  const [row] = store.state.tables.annotation;
  assert.match(Buffer.from(row.documentbody, 'base64').toString(), /"Url":"attachments\//);
  const { subject, notetext, filename, mimetype, documentbody } = row;
  return { subject, notetext, filename, mimetype, documentbody };
}

async function searchSite(t) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-search-azure-notes-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const settings = [
    ['Search/EnableAdditionalEntities', 'true'],
    ['Search/IndexNotesAttachments', 'true'],
    ['KnowledgeManagement/DisplayNotes', 'true'],
  ];
  const files = {
    'portal/website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented note search`,
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Article.webpage.yml': `adx_webpageid: ${ARTICLE_PAGE}\nadx_name: Article\nadx_partialurl: article\nadx_parentpageid: home\nadx_pagetemplateid: main`,
    'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html':
      '<main id=probe>{% searchindex query: request.params.q %}{% for r in searchindex.results %}<li data-ln="{{ r.logical_name }}">{{ r.title }}|{{ r.fragment }}</li>{% endfor %}{% endsearchindex %}</main>',
    'portal/sitesetting.yml': settings
      .map(([name, value], index) => `- adx_sitesettingid: s${index}\n  adx_name: ${name}\n  adx_value: "${value}"`)
      .join('\n'),
    'portal/webrole.yml': '- adx_webroleid: anonymous\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true',
    'portal/sitemarker.yml': `- adx_sitemarkerid: m1\n  adx_name: Knowledge Article\n  adx_pageid: ${ARTICLE_PAGE}`,
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedNoteSearch</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/knowledgearticle/Entity.xml': entity(
      'knowledgearticle',
      ['title', 'content', 'isinternal', 'statecode'],
      'title',
    ),
    'solution/Entities/knowledgearticle/SavedQueries/search.xml': view('knowledgearticle', id(80), [
      'title',
      'content',
    ]),
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const note = (n, values) => ({
    annotationid: id(n),
    objectid: { id: ARTICLE, logical_name: 'knowledgearticle' },
    objecttypecode: 'knowledgearticle',
    ...values,
  });
  const placeholder = { Name: 'drawing.txt', Type: 'text/plain', Size: 9, Url: `zephyrvault/${id(41)}/drawing.txt` };
  const formNote = await formCloudNote();
  const sim = await createSimulator({
    sourceDir: path.join(dir, 'portal'),
    solutionRoots: [path.join(dir, 'solution')],
    port: 0,
    watch: false,
    initial: {
      version: 1,
      mappings: {
        knowledgearticle: { entitySet: 'knowledgearticles', idColumn: 'knowledgearticleid', nameColumn: 'title' },
        annotation: { entitySet: 'annotations', idColumn: 'annotationid' },
      },
      tables: {
        knowledgearticle: [
          { knowledgearticleid: ARTICLE, title: 'Harbour guide', content: 'quay', isinternal: false, statecode: 3 },
        ],
        annotation: [
          note(40, {
            subject: 'Plain upload',
            notetext: '*WEB* plain',
            filename: 'plain.txt',
            mimetype: 'text/plain',
            documentbody: base64('lighthouse zephyrvault/other/plain.txt attachments application'),
          }),
          note(41, {
            subject: 'Azure upload',
            notetext: '*WEB* azure',
            filename: 'drawing.txt.azure.txt',
            mimetype: 'text/plain',
            documentbody: base64(JSON.stringify(placeholder)),
          }),
          note(42, formNote),
        ],
      },
      permissions: [
        { id: 'ka', entity: 'knowledgearticle', scope: 'global', roles: ['Anonymous Users'], operations: ['read'] },
        { id: 'notes', entity: 'annotation', scope: 'global', roles: ['Anonymous Users'], operations: ['read'] },
      ],
      settings: { permissionMode: 'enforce' },
      simulator: { mode: 'local', pageMode: 'local', permissionSource: 'configured', endpoints: [] },
    },
  });
  ownedFixture(t).add(() => sim.close());
  return async (q) => {
    const response = await fetch(`${sim.url}/?${new URLSearchParams({ q })}`);
    const html = await response.text();
    assert.equal(response.status, 200, html.slice(0, 500));
    const main = /<main id=probe>([\s\S]*?)<\/main>/.exec(html)[1];
    return [...main.matchAll(/<li data-ln="([^"]*)">([^|]*)\|([\s\S]*?)<\/li>/g)].map(([, ln, title, fragment]) => ({
      ln,
      title,
      fragment,
    }));
  };
}

test('an Azure file Web API placeholder note is found by subject and file name, never by its placeholder body', async (t) => {
  const search = await searchSite(t);
  // The plain note's body is searched, so the body index is on.
  assert.deepEqual(
    (await search('lighthouse')).map(({ ln, title }) => [ln, title]),
    [['annotation', 'plain.txt']],
  );
  // The placeholder's storage key, container and JSON field names are not search content.
  assert.deepEqual(
    (await search('zephyrvault')).map(({ title }) => title),
    ['plain.txt'],
    'the container name is found in the plain body only, never in the placeholder',
  );
  for (const term of ['Url', 'Size']) assert.deepEqual(await search(term), [], term);
  assert.deepEqual(
    (await search('Azure')).map(({ ln, title }) => [ln, title]),
    [['annotation', 'drawing.txt.azure.txt']],
    'the subject and file name are still indexed',
  );
  for (const { fragment } of await search('drawing')) assert.doesNotMatch(fragment, /zephyrvault|Url/);
});

test('a form attachment stored in cloud storage is found by file name, never by its placeholder body', async (t) => {
  const search = await searchSite(t);
  // Its container and the placeholder's Type are in the plain note body too; only that note matches them.
  for (const term of ['attachments', 'application'])
    assert.deepEqual(
      (await search(term)).map(({ title }) => title),
      ['plain.txt'],
      term,
    );
  assert.deepEqual(
    (await search('Survey')).map(({ ln, title }) => [ln, title]),
    [['annotation', 'Survey.pdf.txt']],
    'the file name is still indexed',
  );
  for (const { fragment } of await search('Survey')) assert.doesNotMatch(fragment, /attachments\/|Url/);
});
