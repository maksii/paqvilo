// @test-kind contract: the notes service follows provider cursors before reporting a chronological, portal-visible page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { handleNativeService, parseFetchTree } from '../lib/native-services.mjs';
import { serveRoutes } from './support/route-server.mjs';

const id = (n) => `01000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const website = id(100);
const contact = id(101);
const other = id(102);
const identity = { contactId: contact, id: contact, roles: ['Reader'] };
const lookup = (recordId, logicalName = 'contact') => ({ id: recordId, logical_name: logicalName });
const note = (n, day, overrides = {}) => ({
  annotationid: id(n),
  notetext: `*WEB*Note ${n}`,
  subject: 'Public',
  objectid: lookup(contact),
  objecttypecode: 'contact',
  owner: lookup(contact),
  createdon: `2026-01-0${day}T00:00:00Z`,
  ...overrides,
});

async function notesFixture(t, alter = (result) => result, extra = []) {
  const state = emptyState();
  state.mappings = {
    contact: { logicalName: 'contact', entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
    annotation: {
      logicalName: 'annotation',
      entitySet: 'annotations',
      idColumn: 'annotationid',
      nameColumn: 'subject',
    },
  };
  state.tables.contact = [
    { contactid: contact, fullname: 'Reader' },
    { contactid: other, fullname: 'Other' },
  ];
  state.tables.annotation = [
    note(8, 1),
    note(2, 1, { notetext: 'Internal' }),
    note(6, 1),
    note(1, 2, { subject: `*PRIVATE* by Other [contact:${other}]` }),
    note(3, 2, { owner: lookup(other) }),
    note(4, 2, { objectid: lookup(contact, 'account'), objecttypecode: 'account' }),
    note(9, 3, { subject: `*PRIVATE* by Reader [contact:${contact}]`, filename: 'note.txt', filesize: 20 }),
    ...extra,
  ];
  state.permissions = [
    { entity: 'contact', scope: 'global', roles: ['Reader'], operations: ['read'] },
    { entity: 'annotation', scope: 'contact', field: 'owner', roles: ['Reader'], operations: ['read'] },
  ];
  state.settings.permissionMode = 'enforce';
  const store = await new DataStore({ state }).init();
  const pages = [];
  const diagnostics = [];
  const context = {
    store,
    identity,
    csrf: 'page-token',
    recordDiagnostic: (entry) => diagnostics.push(entry),
    portal: { website: { id: website }, settings: {} },
    readProvider: {
      get: (entity, recordId, caller) => store.get(entity, recordId, caller, { portalRequest: true }),
      fetchXml(xml, caller) {
        assert.equal(caller, identity);
        const { attrs } = parseFetchTree(xml);
        const query = xml.replace(/<fetch(?: count="\d+")?/, '<fetch count="2"');
        const result = store.fetchXml(query, caller, { portalRequest: true });
        pages.push({
          xml,
          page: Number(attrs.page ?? 1),
          requestCookie: attrs['paging-cookie'] ?? null,
          responseCookie: result.paging_cookie,
          ids: result.entities.map((row) => row.annotationid),
        });
        const answered = alter(result, pages);
        pages.at(-1).rows = answered.entities;
        return answered;
      },
    },
  };
  const origin = await serveRoutes(t, (req, res, url) => handleNativeService(req, res, url, context));
  const post = (page, Direction) =>
    fetch(`${origin}/_services/entity-notes/${website}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', __RequestVerificationToken: context.csrf },
      body: JSON.stringify({
        regarding: { LogicalName: 'contact', Id: contact },
        page,
        pageSize: 2,
        orders: [{ Attribute: 'createdon', Direction }],
      }),
    });
  return { post, pages, diagnostics };
}

test('notes page totals and ordering span provider cursor pages after permission and visibility checks', async (t) => {
  const { post, pages } = await notesFixture(t);
  const request = async (page, direction) => {
    const response = await post(page, direction);
    assert.equal(response.status, 200);
    return response.json();
  };
  const ascending = await request(1, null);
  assert.deepEqual([ascending.ItemCount, ascending.PageCount, ascending.MoreRecords], [3, 2, true]);
  assert.deepEqual(
    ascending.Records.map((record) => record.Id),
    [id(8), id(6)],
  );
  assert.deepEqual(
    pages.map((entry) => entry.page),
    [1, 2, 3],
  );
  assert.equal(pages[1].requestCookie, pages[0].responseCookie);
  assert.equal(pages[2].requestCookie, pages[1].responseCookie);
  assert.ok(!pages.flatMap((page) => page.ids).includes(id(3)), 'provider must trim a row without annotation Read');

  const last = await request(2, null);
  assert.deepEqual([last.PageNumber, last.MoreRecords, last.NextPagePagingCookie], [2, false, null]);
  assert.deepEqual(
    last.Records.map(({ Id, AttachmentFileName }) => [Id, AttachmentFileName]),
    [[id(9), 'note.txt']],
  );
  const descending = await request(1, 1);
  assert.deepEqual(
    descending.Records.map((record) => record.Id),
    [id(9), id(6)],
  );
});

test('notes read every provider page, beyond the former four-page cap, and project no attachment body', async (t) => {
  // 13 more visible notes with a file body: with the provider's two-row pages the scan takes ten pages (the former cap
  // was four pages and answered 501).
  const extra = Array.from({ length: 13 }, (_, index) =>
    note(20 + index, 4, {
      filename: `file-${index}.txt`,
      filesize: 4,
      documentbody: Buffer.from('body').toString('base64'),
    }),
  );
  const { post, pages } = await notesFixture(t, undefined, extra);
  const response = await post(1, null);
  assert.equal(response.status, 200);
  const listed = await response.json();
  assert.deepEqual([listed.ItemCount, listed.PageCount], [16, 8]);
  assert.equal(pages.length, 10);
  for (const [index, entry] of pages.entries()) {
    if (index) assert.equal(entry.requestCookie, pages[index - 1].responseCookie);
    assert.doesNotMatch(entry.xml, /all-attributes|documentbody/);
    for (const row of entry.rows) assert.equal(Object.hasOwn(row, 'documentbody'), false);
  }
  const last = await (await post(8, null)).json();
  assert.deepEqual(
    last.Records.map(({ AttachmentFileName, AttachmentSizeDisplay }) => [AttachmentFileName, AttachmentSizeDisplay]),
    [
      ['file-11.txt', '4 bytes'],
      ['file-12.txt', '4 bytes'],
    ],
  );
});

test('notes continue by page number when a provider page carries no paging cookie (simple paging)', async (t) => {
  const { post, pages } = await notesFixture(t, (result) => ({ ...result, paging_cookie: null }));
  const response = await post(1, null);
  assert.equal(response.status, 200);
  const listed = await response.json();
  assert.equal(listed.ItemCount, 3);
  assert.deepEqual(
    listed.Records.map((record) => record.Id),
    [id(8), id(6)],
  );
  assert.deepEqual(
    pages.map(({ page, requestCookie }) => [page, requestCookie]),
    [
      [1, null],
      [2, null],
      [3, null],
    ],
  );
});

test('a record with more notes than the memory bound answers 503 with a diagnostic instead of loading them all', async (t) => {
  // Full provider pages of 5,000 notes, eleven of them (55,000 rows) before the provider would stop.
  const fullPage = (page) =>
    Array.from({ length: 5000 }, (_, index) => ({
      ...note(0, 1),
      annotationid: `02${String(page).padStart(6, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`,
    }));
  const { post, pages, diagnostics } = await notesFixture(t, (result, providerPages) => {
    const page = providerPages.length;
    return { entities: fullPage(page), more_records: page < 12, paging_cookie: null };
  });
  const response = await post(1, null);
  assert.equal(response.status, 503, await response.clone().text());
  const error = await response.json();
  assert.equal(error.InnerError.Code, 'NotesRowLimitExceeded');
  assert.equal(Object.hasOwn(error, 'ItemCount'), false);
  // The read stops at the page that crosses 50,000 rows.
  assert.equal(pages.length, 11);
  assert.deepEqual(
    diagnostics.map(({ code, severity }) => [code, severity]),
    [['NotesRowLimitExceeded', 'warning']],
  );
  assert.match(diagnostics[0].message, /more than 50,000 notes/);
});

test('notes answer a provider fault without a partial total when a paging cookie repeats', async (t) => {
  const { post, pages } = await notesFixture(t, (result, providerPages) => ({
    ...result,
    paging_cookie: providerPages[0].responseCookie,
  }));
  const response = await post(1, 1);
  assert.equal(response.status, 502);
  const error = await response.json();
  assert.equal(error.InnerError.Code, 'NotesProviderPagingInvalid');
  assert.equal(Object.hasOwn(error, 'ItemCount'), false);
  assert.equal(Object.hasOwn(error, 'Records'), false);
  assert.equal(pages.length, 2);
});
