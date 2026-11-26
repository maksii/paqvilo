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

async function notesFixture(t, alter = (result) => result) {
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
  ];
  state.permissions = [
    { entity: 'contact', scope: 'global', roles: ['Reader'], operations: ['read'] },
    { entity: 'annotation', scope: 'contact', field: 'owner', roles: ['Reader'], operations: ['read'] },
  ];
  state.settings.permissionMode = 'enforce';
  const store = await new DataStore({ state }).init();
  const pages = [];
  const context = {
    store,
    identity,
    csrf: 'page-token',
    portal: { website: { id: website }, settings: {} },
    readProvider: {
      get: (entity, recordId, caller) => store.get(entity, recordId, caller, { portalRequest: true }),
      fetchXml(xml, caller) {
        assert.equal(caller, identity);
        const { attrs } = parseFetchTree(xml);
        const query = xml.replace(/<fetch(?: count="\d+")?/, '<fetch count="2"');
        const result = store.fetchXml(query, caller, { portalRequest: true });
        pages.push({
          page: Number(attrs.page ?? 1),
          requestCookie: attrs['paging-cookie'] ?? null,
          responseCookie: result.paging_cookie,
          ids: result.entities.map((row) => row.annotationid),
        });
        return alter(result, pages);
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
  return { post, pages };
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

for (const [name, calls, cursor] of [
  ['missing', 1, () => null],
  ['repeated', 2, (pages) => pages[0].responseCookie],
]) {
  test(`notes reject a ${name} provider cursor without returning a partial total`, async (t) => {
    const { post, pages } = await notesFixture(t, (result, providerPages) => ({
      ...result,
      paging_cookie: cursor(providerPages),
    }));
    const response = await post(1, 1);
    assert.equal(response.status, 501);
    const error = await response.json();
    assert.equal(error.InnerError.Code, 'NotesPagingUnresolved');
    assert.equal(Object.hasOwn(error, 'ItemCount'), false);
    assert.equal(Object.hasOwn(error, 'Records'), false);
    assert.equal(pages.length, calls);
  });
}
