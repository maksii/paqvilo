// @test-kind contract: the native portal services (notes, grids, lists, downloads) as the designed local runtime answers them.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import {
  protectConfiguration,
  unprotectConfiguration,
  portalNotes,
  reportCapturedBundleRequirements,
  gridRecord,
  handleNativeService,
  attributeEntry,
} from '../lib/native-services.mjs';
import { notesFilter } from '../lib/form-service.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import {
  ATTRIBUTE_TYPE_NAMES,
  attributeTypeCode,
  attributeTypeDisplayName,
  attributeTypeNumber,
} from '../lib/attribute-metadata.mjs';

test('native grids preserve zone-less DateOnly and independent dates across host time zones', () => {
  const previous = process.env.TZ;
  try {
    for (const timezone of ['Europe/Kyiv', 'America/Los_Angeles', 'UTC']) {
      process.env.TZ = timezone;
      const fields = {
        calendar: { type: 'datetime', dataverseType: 'datetime', dateTimeBehavior: 'DateOnly', format: 'DateOnly' },
        independent: { type: 'datetime', dataverseType: 'datetime', dateTimeBehavior: 'TimeZoneIndependent' },
      };
      const context = { metadata: { entities: { item: { fields } } }, portal: { settings: {} }, timezoneOffset: -120 };
      const model = {
        entity: 'item',
        idColumn: 'itemid',
        kind: 'lookup',
        view: { fetchXml: '<fetch><entity name="item"/></fetch>' },
      };
      const result = gridRecord(
        {
          itemid: '10000000-0000-4000-8000-000000000001',
          calendar: '2026-11-20T00:00:00.0000000',
          independent: '2026-11-20T10:30:00.0000000',
        },
        model,
        { Columns: [] },
        context,
      );
      const attributes = Object.fromEntries(result.Attributes.map((row) => [row.Name, row]));
      assert.equal(attributes.calendar.DisplayValue, '2026-11-20', timezone);
      assert.equal(attributes.calendar.FormattedValue, '11/20/2026', timezone);
      assert.equal(attributes.independent.FormattedValue, '11/20/2026 10:30 AM', timezone);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('native grids name a lookup stored as a bare id through its N:1 relationship', async () => {
  const { DataStore, emptyState } = await import('../lib/data.mjs');
  const state = emptyState();
  state.mappings.x_region = {
    logicalName: 'x_region',
    entitySet: 'x_regions',
    idColumn: 'x_regionid',
    nameColumn: 'x_name',
    userConfigured: true,
    fields: { x_name: { dataverseType: 'nvarchar' } },
    relationships: {},
  };
  state.mappings.x_item = {
    logicalName: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    nameColumn: 'x_name',
    userConfigured: true,
    fields: {
      x_name: { dataverseType: 'nvarchar' },
      x_regionid: { dataverseType: 'lookup', lookupTargets: ['x_region'] },
    },
    relationships: { x_regionid: { entity: 'x_region', from: 'x_regionid', to: 'x_regionid', many: false } },
  };
  state.tables.x_region = [{ x_regionid: '10000000-0000-4000-8000-0000000000a1', x_name: 'North' }];
  state.tables.x_item = [];
  const store = await new DataStore({ state }).init();
  const context = {
    store,
    metadata: { entities: { x_item: { fields: state.mappings.x_item.fields } } },
    portal: { settings: {} },
  };
  const model = {
    entity: 'x_item',
    idColumn: 'x_itemid',
    kind: 'list',
    view: { fetchXml: '<fetch><entity name="x_item"><attribute name="x_regionid"/></entity></fetch>' },
  };
  const layout = { Columns: [{ Type: 0, LogicalName: 'x_regionid' }] };
  const result = gridRecord(
    { x_itemid: '10000000-0000-4000-8000-0000000000b1', x_regionid: '10000000-0000-4000-8000-0000000000a1' },
    model,
    layout,
    context,
  );
  const region = result.Attributes.find((row) => row.Name === 'x_regionid');
  assert.deepEqual([region.Value.LogicalName, region.Value.Name, region.DisplayValue], ['x_region', 'North', 'North']);
});

test('a captured locale with an incomplete captured global provider is diagnosed once', async () => {
  const diagnostics = [],
    provider = '/resource/powerappsportal/dist/postpreform.BootstrapV5.bundle-abcdef.js';
  const context = {
    recordDiagnostic: (row) => diagnostics.push(row),
    config: { shellProfile: { afterFooterScripts: [provider] } },
    cache: { get: async () => ({ body: Buffer.from('Date.today=function(){};') }) },
  };
  for (let i = 0; i < 2; i++)
    await reportCapturedBundleRequirements(
      { id: 'moment-locale' },
      { body: Buffer.from('jQuery.timeago.settings.strings={};') },
      context,
      '/locale.js',
    );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'PLATFORM_BUNDLE_GLOBAL_UNPROVIDED');
});

const SITE = '4f1d9b2a-7c3e-4a5b-9d6e-1a2b3c4d5e6f';
const CONTACT = 'c0000000-0000-4000-8000-000000000001';
const ACCOUNTS = {
  alpha: 'a0000000-0000-4000-8000-000000000001',
  beta: 'a0000000-0000-4000-8000-000000000002',
  gamma: 'a0000000-0000-4000-8000-000000000003',
};
const NOTE = 'e0000000-0000-4000-8000-000000000001';
const INTERNAL_NOTE = 'e0000000-0000-4000-8000-000000000002';

async function fixture(t, { roles = ['Editor'], siteSettings = '', accountList = '' } = {}) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'native-services-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Native`,
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': `{% include 'entity_list' key: 'Accounts' %}{% entityform name: "Edit contact" %}`,
    'Accounts.list.yml':
      'adx_entitylistid: 1b000000-0000-4000-8000-000000000001\nadx_name: Accounts\nadx_entityname: account\nadx_pagesize: 2\nadx_searchenabled: true' +
      accountList,
    'Edit.basicform.yml':
      'adx_entityformid: 2b000000-0000-4000-8000-000000000001\nadx_name: Edit contact\nadx_entityname: contact\nadx_mode: 100000001',
    ...(siteSettings ? { 'sitesetting.yml': siteSettings } : {}),
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const grant = (entity, operations) => ({
    id: `editor-${entity}`,
    entity,
    scope: 'global',
    roles: ['Editor'],
    operations,
  });
  const initial = {
    version: 1,
    mappings: {
      contact: {
        entitySet: 'contacts',
        idColumn: 'contactid',
        nameColumn: 'fullname',
        relationships: {
          parentcustomerid_account: { entity: 'account', from: 'parentcustomerid', to: 'accountid', many: false },
        },
      },
      account: { entitySet: 'accounts', idColumn: 'accountid', nameColumn: 'name' },
      annotation: { entitySet: 'annotations', idColumn: 'annotationid', nameColumn: 'subject' },
    },
    tables: {
      contact: [
        {
          contactid: CONTACT,
          fullname: 'Ada',
          parentcustomerid: { id: ACCOUNTS.alpha, logical_name: 'account', name: 'Alpha' },
        },
      ],
      account: [
        { accountid: ACCOUNTS.alpha, name: 'Alpha', city: 'London' },
        { accountid: ACCOUNTS.beta, name: 'Beta', city: 'Paris' },
        { accountid: ACCOUNTS.gamma, name: 'Gamma', city: 'Rome' },
      ],
      annotation: [
        {
          annotationid: NOTE,
          notetext: '*WEB*Shared note',
          subject: 'Note created by Ada',
          objecttypecode: 'contact',
          objectid: { id: CONTACT, logical_name: 'contact' },
          filename: 'evidence.txt',
          mimetype: 'text/plain',
          documentbody: Buffer.from('evidence').toString('base64'),
          createdon: '2026-01-02T03:04:05Z',
        },
        {
          annotationid: INTERNAL_NOTE,
          notetext: 'Internal only',
          subject: 'Back office',
          objecttypecode: 'contact',
          objectid: { id: CONTACT, logical_name: 'contact' },
          createdon: '2026-01-01T00:00:00Z',
        },
      ],
    },
    permissions: [grant('contact', ['read', 'update']), grant('account', ['read']), grant('annotation', ['read'])],
    settings: { permissionMode: 'enforce' },
    simulator: {
      mode: 'local',
      pageMode: 'local',
      identity: { id: CONTACT, contactId: CONTACT, fullname: 'Ada', roles },
      live: { origin: null },
      endpoints: [],
      componentSchemas: {
        Accounts: {
          entity: 'account',
          fields: [
            { name: 'name', label: 'Account name' },
            { name: 'city', label: 'City' },
          ],
        },
        '2b000000-0000-4000-8000-000000000001': {
          entity: 'contact',
          mode: 100000001,
          fields: [
            { name: 'fullname', label: 'Full name' },
            { name: 'parentcustomerid', label: 'Organisation', type: 'lookup' },
          ],
        },
      },
    },
  };
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, 'state.json'), initial, watch: false });
  ownedFixture(t).add(() => app.close());
  // Portal requests are signed in explicitly (paqvilo-mirage-auth session) as the persona.
  const session = signInHeaders(app, CONTACT, { roles });
  const token = app.csrf;
  const post = (action, body, headers = { __RequestVerificationToken: token }) =>
    fetch(`${app.url}/_services/${action}/${SITE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...session, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const get = (pathname) => fetch(app.url + pathname, { headers: session });
  return { app, post, get };
}

// Read-only service tests share one runtime; tests that change state start their own.
let shared;
const cleanup = [];
before(async () => {
  shared = await fixture({ after: (fn) => cleanup.push(fn) });
});
after(async () => {
  for (const fn of cleanup) await fn();
});

const layoutsAfter = (html, marker) => {
  const encoded = /data-view-layouts="([^"]*)"/.exec(html.slice(html.indexOf(marker)))[1];
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
};
const gridRequest = (secure, extra = {}) => ({
  base64SecureConfiguration: secure,
  sortExpression: '',
  search: '',
  page: 1,
  pageSize: 2,
  pagingCookie: '',
  filter: null,
  metaFilter: null,
  nlSearchFilter: '',
  timezoneOffset: 0,
  customParameters: [],
  ...extra,
});
const names = (data) =>
  data.Records.map((record) => record.Attributes.find((attribute) => attribute.Name === 'name').Value);

// @test-kind security: a tampered protected grid configuration is refused
test('protected grid configuration round-trips and rejects tampering', () => {
  const token = protectConfiguration({ t: 'list', w: SITE, list: 'x' });
  assert.deepEqual(unprotectConfiguration(token), { t: 'list', w: SITE, list: 'x' });
  const [payload] = Buffer.from(token, 'base64').toString('utf8').split('.');
  const forged = Buffer.from(`${payload}.0000`).toString('base64');
  assert.throws(
    () => unprotectConfiguration(forged),
    (error) => error.status === 403,
  );
  assert.throws(
    () => unprotectConfiguration('not-a-token'),
    (error) => error.status === 403,
  );
});

test('entity grid service returns the native paging, search and layout-only sort contract', async () => {
  const { post, get } = shared;
  const page = await (await get(`/?id=${CONTACT}`)).text();
  assert.match(page, new RegExp(`data-get-url="/_services/entity-grid-data.json/${SITE}"`));
  const [layout] = layoutsAfter(page, 'class="entity-grid entitylist');
  assert.deepEqual(
    layout.Columns.map((column) => [column.LogicalName, column.Name]),
    [
      ['name', 'Account name'],
      ['city', 'City'],
    ],
  );
  const secure = layout.Base64SecureConfiguration;
  assert.equal((await post('entity-grid-data.json', gridRequest(secure), {})).status, 403);
  const response = await post('entity-grid-data.json', gridRequest(secure));
  assert.equal(response.status, 200);
  // The service answers with the page no-cache policy and frame confinement.
  assert.deepEqual(
    ['cache-control', 'pragma', 'expires', 'x-frame-options'].map((name) => response.headers.get(name)),
    ['no-cache, no-store, must-revalidate', 'no-cache', '-1', 'SAMEORIGIN'],
  );
  let data = await response.json();
  assert.deepEqual(
    [data.ItemCount, data.PageCount, data.PageNumber, data.PageSize, data.MoreRecords],
    [3, 2, 1, 2, true],
  );
  const name = data.Records[0].Attributes.find((attribute) => attribute.Name === 'name');
  assert.deepEqual([name.Type, typeof name.FormattedValue], ['System.String', 'string']);
  assert.equal(data.Records[0].EntityName, 'account');
  data = await (await post('entity-grid-data.json', gridRequest(secure, { page: 2 }))).json();
  assert.deepEqual([data.Records.length, data.MoreRecords, data.PageNumber], [1, false, 2]);
  // Quick search is begins-with on the view's text columns; * is the wildcard.
  data = await (await post('entity-grid-data.json', gridRequest(secure, { search: 'Ga' }))).json();
  assert.deepEqual(names(data), ['Gamma']);
  data = await (await post('entity-grid-data.json', gridRequest(secure, { search: '*ar' }))).json();
  assert.deepEqual(names(data), ['Beta']);
  data = await (
    await post('entity-grid-data.json', gridRequest(secure, { sortExpression: 'name DESC', pageSize: 3 }))
  ).json();
  assert.deepEqual(names(data), ['Gamma', 'Beta', 'Alpha']);
  // A sort on a column outside the layout is ignored rather than leaking other columns.
  data = await (
    await post('entity-grid-data.json', gridRequest(secure, { sortExpression: 'accountid DESC', pageSize: 3 }))
  ).json();
  assert.deepEqual(names(data), ['Alpha', 'Beta', 'Gamma']);
  // The opaque configuration is bound to its endpoint kind and signature.
  assert.equal((await post('entity-subgrid-data.json', gridRequest(secure))).status, 403);
  const forged = Buffer.from(
    `${Buffer.from(JSON.stringify({ t: 'list', w: SITE })).toString('base64url')}.forged`,
  ).toString('base64');
  assert.equal((await post('entity-grid-data.json', gridRequest(forged))).status, 403);
});

test("lookup grid service serves the editable lookup's target view on demand", async () => {
  const { post, get } = shared;
  const page = await (await get(`/?id=${CONTACT}`)).text();
  assert.match(page, /value="Alpha"[^>]*id="parentcustomerid_name"/);
  assert.match(
    page,
    /<button type="button" class="btn btn-default launchentitylookup"[^>]*aria-label="Organisation Launch lookup modal"/,
  );
  const [layout] = layoutsAfter(page, 'id="parentcustomerid_lookupmodal"');
  assert.equal(layout.Configuration.EntityName, 'account');
  const response = await post(
    'entity-lookup-grid-data.json',
    gridRequest(layout.Base64SecureConfiguration, { pageSize: 10 }),
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.Records.map((record) => record.Id).sort(), Object.values(ACCOUNTS).sort());
  assert.equal((await post('entity-grid-data.json', gridRequest(layout.Base64SecureConfiguration))).status, 403);
});

// @test-kind security: a grid read is denied where table permissions deny it
test('grid reads follow table permissions and report native access denial', async (t) => {
  const { app, post, get } = await fixture(t);
  const page = await (await get(`/?id=${CONTACT}`)).text();
  const [layout] = layoutsAfter(page, 'class="entity-grid entitylist');
  const state = app.store.snapshot();
  state.permissions = state.permissions.filter((rule) => rule.entity !== 'account');
  await app.store.replaceState(state);
  const response = await post('entity-grid-data.json', gridRequest(layout.Base64SecureConfiguration));
  assert.deepEqual(await response.json(), { AccessDenied: true });
  // Live: the denial is cache-control private, without the no-cache pragma/expires of a data page.
  assert.deepEqual(
    [response.headers.get('cache-control'), response.headers.get('pragma'), response.headers.get('expires')],
    ['private', null, null],
  );
});

test('notes service lists portal notes and annotation downloads stream the document body', async () => {
  const { post, get } = shared;
  const response = await post('entity-notes', {
    regarding: { LogicalName: 'contact', Id: CONTACT },
    page: 1,
    pageSize: 10,
  });
  assert.equal(response.status, 200);
  const notes = await response.json();
  // Only *WEB* notes are portal notes; the prefix is not displayed.
  assert.deepEqual(
    notes.Records.map((record) => [record.Id, record.UnformattedText, record.HasAttachment]),
    [[NOTE, 'Shared note', true]],
  );
  assert.equal(notes.Records[0].AttachmentUrl, `/_entity/annotation/${NOTE}/${SITE}`);
  assert.equal(notes.Records[0].AttachmentSizeDisplay, '8 bytes');
  // Live contract: AttachmentSize serialises as {}, unset paging/view members are null.
  assert.deepEqual(
    [
      notes.Records[0].AttachmentSize,
      notes.Records[0].CanAppend,
      notes.CreateActionMetadata,
      notes.DisabledItemActionLinks,
      notes.NextPagePagingCookie,
    ],
    [{}, true, null, null, null],
  );
  const download = await get(notes.Records[0].AttachmentUrl);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'text/plain');
  assert.match(download.headers.get('content-disposition'), /^attachment;filename="evidence\.txt"$/);
  assert.equal(await download.text(), 'evidence');
  assert.equal((await get(`/_entity/annotation/e0000000-0000-4000-8000-0000000000ff`)).status, 404);
  assert.equal((await post('entity-notes', { regarding: { LogicalName: 'contact', Id: CONTACT } }, {})).status, 403);
});

test('anti-forgery token endpoint returns the native hidden input', async () => {
  const { app, get } = shared;
  const html = await (await get(`/_portal/${SITE}/Layout/GetAntiForgeryToken`)).text();
  assert.equal(html, `<input name="__RequestVerificationToken" type="hidden" value="${app.portalToken}" />`);
});

function notesEditorPermissions() {
  const grant = (entity, operations) => ({
    id: `editor-${entity}`,
    entity,
    scope: 'global',
    roles: ['Editor'],
    operations,
  });
  return [
    grant('contact', ['read', 'update', 'append', 'appendTo']),
    grant('account', ['read']),
    grant('annotation', ['read', 'create', 'update', 'delete', 'append', 'appendTo']),
  ];
}

test("notes service adds, edits and deletes the signed-in contact's own portal notes", async (t) => {
  const { app, post, get } = await fixture(t);
  const state = app.store.snapshot();
  state.permissions = notesEditorPermissions();
  await app.store.replaceState(state);
  const list = async () =>
    (
      await (
        await post('entity-notes', { regarding: { LogicalName: 'contact', Id: CONTACT }, page: 1, pageSize: 10 })
      ).json()
    ).Records;

  const added = await post('entity-form-addnote', {
    regardingEntityLogicalName: 'contact',
    regardingEntityId: CONTACT,
    text: 'Local note',
    file: { name: 'local.txt', type: 'text/plain', content: Buffer.from('local evidence').toString('base64') },
  });
  assert.equal(added.status, 201);
  const { Id: id } = await added.json();
  let mine = (await list()).find((record) => record.Id === id);
  assert.deepEqual(
    [
      mine.UnformattedText,
      mine.IsPostedByCurrentUser,
      mine.CanWrite,
      mine.CanDelete,
      mine.PostedByName,
      mine.AttachmentFileName,
      mine.AttachmentSizeDisplay,
    ],
    ['Local note', true, true, true, 'Ada', 'local.txt', '14 bytes'],
  );
  assert.equal(await (await get(mine.AttachmentUrl)).text(), 'local evidence');
  // Notes the contact did not post stay read-only for it.
  assert.equal((await list()).find((record) => record.Id === NOTE).CanWrite, false);

  assert.equal((await post('entity-form-updatenote', { id, text: 'Edited note' })).status, 200);
  mine = (await list()).find((record) => record.Id === id);
  assert.equal(mine.UnformattedText, 'Edited note');
  assert.equal((await post('entity-form-updatenote', { id, text: '  ' })).status, 417);
  assert.equal((await post('entity-form-updatenote', { id: NOTE, text: 'Not mine' })).status, 403);
  assert.equal(
    (await post('entity-form-addnote', { regardingEntityLogicalName: 'contact', regardingEntityId: CONTACT, text: '' }))
      .status,
    417,
  );
  assert.equal((await post('entity-form-deletenote', { id }, {})).status, 403);

  assert.equal((await post('entity-form-deletenote', { id })).status, 200);
  assert.equal(
    (await list()).some((record) => record.Id === id),
    false,
  );
  assert.equal((await post('entity-form-deletenote', { id: NOTE })).status, 403);

  // objectid is polymorphic: with one navigation property per regarding table (as solutions
  // declare them), the note binds through the contact's and the other tables' are not applied.
  const polymorphic = app.store.snapshot();
  polymorphic.mappings.annotation.relationships = {
    ObjectId: { entity: 'account', from: 'objectid', to: 'accountid', many: false },
    objectid_contact: { entity: 'contact', from: 'objectid', to: 'contactid', many: false },
  };
  await app.store.replaceState(polymorphic);
  const bound = await post('entity-form-addnote', {
    regardingEntityLogicalName: 'contact',
    regardingEntityId: CONTACT,
    text: 'Bound note',
  });
  assert.equal(bound.status, 201);
  // The native form transport gets the platform's empty 201, without Vary (live note-add).
  const native = await post(
    'entity-form-addnote',
    new URLSearchParams({
      regardingEntityLogicalName: 'contact',
      regardingEntityId: CONTACT,
      text: 'Native note',
      __RequestVerificationToken: app.csrf,
    }).toString(),
    { 'content-type': 'application/x-www-form-urlencoded' },
  );
  assert.equal(native.status, 201);
  assert.equal(native.headers.get('vary'), null);
  assert.equal(await native.text(), '');
  const boundId = (await bound.json()).Id;
  assert.deepEqual(app.store.snapshot().tables.annotation.find((row) => row.annotationid === boundId).objectid, {
    id: CONTACT,
    logical_name: 'contact',
    name: 'Ada',
  });
  assert.equal((await list()).find((record) => record.Id === boundId).UnformattedText, 'Bound note');
  assert.equal(
    (
      await post('entity-form-addnote', {
        regardingEntityLogicalName: 'contact',
        regardingEntityId: 'c0000000-0000-4000-8000-0000000000ff',
        text: 'Missing',
      })
    ).status,
    404,
  );
});

test('portal notes follow the KnowledgeManagement/NotesFilter site setting, *WEB* by default', () => {
  assert.equal(notesFilter({ settings: {} }), '*WEB*');
  assert.equal(notesFilter({ settings: { 'knowledgemanagement/notesfilter': { value: '*PORTAL*' } } }), '*PORTAL*');
  const rows = [{ notetext: '*WEB*web' }, { notetext: '*PORTAL*portal' }, { notetext: 'plain' }];
  assert.deepEqual(
    portalNotes(rows, {}).map((row) => row.notetext),
    ['*WEB*web'],
  );
  assert.deepEqual(
    portalNotes(rows, {}, '*PORTAL*').map((row) => row.notetext),
    ['*PORTAL*portal'],
  );
});

test("notes follow the request's createdon direction and keep creation order for notes of the same instant", async (t) => {
  const { app, post } = await fixture(t);
  const state = app.store.snapshot();
  const twin = 'a0000000-0000-4000-8000-0000000000aa';
  state.tables.annotation.push({
    annotationid: twin,
    notetext: '*WEB*Twin note',
    subject: 'Twin',
    objecttypecode: 'contact',
    objectid: { id: CONTACT, logical_name: 'contact' },
    createdon: '2026-01-02T03:04:05Z',
  });
  await app.store.replaceState(state);
  const ids = async (Direction) =>
    (
      await (
        await post('entity-notes', {
          regarding: { LogicalName: 'contact', Id: CONTACT },
          orders: [{ Attribute: 'createdon', Alias: null, Direction }],
          page: 1,
          pageSize: 10,
        })
      ).json()
    ).Records.map((record) => record.Id);
  assert.deepEqual(await ids(null), [NOTE, twin]);
  assert.deepEqual(await ids(1), [twin, NOTE]);
});

test('note records carry their columns as Attributes and the creator as PostedByName', async (t) => {
  const { app, post } = await fixture(t);
  const state = app.store.snapshot();
  Object.assign(
    state.tables.annotation.find((row) => row.annotationid === NOTE),
    {
      createdby: { id: 'a0000000-0000-4000-8000-0000000000bb', logical_name: 'systemuser', name: 'Provisioning User' },
    },
  );
  await app.store.replaceState(state);
  const [note] = (
    await (
      await post('entity-notes', { regarding: { LogicalName: 'contact', Id: CONTACT }, page: 1, pageSize: 10 })
    ).json()
  ).Records;
  const byName = Object.fromEntries(note.Attributes.map((entry) => [entry.Name, entry]));
  assert.equal(note.PostedByName, 'Provisioning User');
  assert.deepEqual(
    [
      byName.createdon.Value,
      byName.createdon.DisplayValue,
      byName.objecttypecode.Value,
      byName.createdby.Value.Name,
      byName.objectid.Value.Name,
      byName.subject.AttributeMetadata,
    ],
    [
      `/Date(${Date.parse('2026-01-02T03:04:05Z')})/`,
      '2026-01-02T03:04:05Z',
      'contact',
      'Provisioning User',
      null,
      null,
    ],
  );
});

test('view cells without a width serialise Width 0 and a NaN share; disableSorting cells cannot sort', async () => {
  const { buildLayout } = await import('../lib/native-services.mjs');
  const view = {
    id: 'v',
    name: 'Cards',
    fetchXml:
      '<fetch><entity name="sample_card"><attribute name="sample_title"/><attribute name="sample_type"/></entity></fetch>',
    fields: [
      { name: 'sample_title', widthless: true },
      { name: 'sample_type', widthless: true, sortDisabled: true },
    ],
  };
  const layout = buildLayout({
    view,
    entity: 'sample_card',
    idColumn: 'sample_cardid',
    primaryName: 'sample_title',
    metadata: {},
    configuration: {},
    secure: { t: 'subgrid' },
  });
  assert.equal(layout.ColumnsTotalWidth, 0);
  assert.deepEqual(
    layout.Columns.map((c) => [c.LogicalName, c.Width, c.WidthAsPercent, c.SortDisabled]),
    [
      ['sample_title', 0, 'NaN', false],
      ['sample_type', 0, 'NaN', true],
    ],
  );
  const sized = buildLayout({
    view: { ...view, fields: [{ name: 'sample_title', width: 300 }, { name: 'sample_type' }] },
    entity: 'sample_card',
    idColumn: 'sample_cardid',
    primaryName: 'sample_title',
    metadata: {},
    configuration: {},
    secure: { t: 'subgrid' },
  });
  assert.deepEqual([sized.ColumnsTotalWidth, sized.Columns.map((c) => c.Width)], [400, [300, 100]]);
});

// @test-kind contract: an edited note keeps the site's NotesFilter prefix, so it stays on the portal timeline.
test('an edited note keeps the NotesFilter prefix of its site and stays listed', async (t) => {
  const siteSettings =
    '- adx_sitesettingid: s-notes\n  adx_name: KnowledgeManagement/NotesFilter\n  adx_value: "*PORTAL*"';
  const { app, post } = await fixture(t, { siteSettings });
  const state = app.store.snapshot();
  state.permissions = notesEditorPermissions();
  await app.store.replaceState(state);
  const listed = async () =>
    (
      await (
        await post('entity-notes', { regarding: { LogicalName: 'contact', Id: CONTACT }, page: 1, pageSize: 10 })
      ).json()
    ).Records.map((record) => record.UnformattedText);

  const added = await post('entity-form-addnote', {
    regardingEntityLogicalName: 'contact',
    regardingEntityId: CONTACT,
    text: 'hello',
  });
  assert.equal(added.status, 201);
  const { Id: id } = await added.json();
  assert.ok((await listed()).includes('hello'));
  assert.equal((await post('entity-form-updatenote', { id, text: 'edited' })).status, 200);
  assert.ok((await listed()).includes('edited'));
  const stored = app.store.snapshot().tables.annotation.find((row) => row.annotationid === id);
  assert.ok(stored.notetext.startsWith('*PORTAL*'), stored.notetext);
});

// @test-kind contract: a list that configures only a portal-user filter attribute filters by it, whatever filter the request names.
test('a list with only a portal-user filter attribute applies it for every request filter', async (t) => {
  const { app, post, get } = await fixture(t, { accountList: '\nadx_filterportaluser: portalowner' });
  const state = app.store.snapshot();
  const [alpha, beta, gamma] = state.tables.account;
  alpha.portalowner = CONTACT;
  beta.portalowner = 'c0000000-0000-4000-8000-0000000000ee';
  gamma.portalowner = 'c0000000-0000-4000-8000-0000000000ee';
  await app.store.replaceState(state);
  const [layout] = layoutsAfter(await (await get('/')).text(), 'class="entity-grid entitylist');
  for (const filter of [undefined, 'user', 'account']) {
    const data = await (
      await post('entity-grid-data.json', gridRequest(layout.Base64SecureConfiguration, { filter, pageSize: 10 }))
    ).json();
    assert.deepEqual(names(data), ['Alpha'], `filter ${filter}`);
  }
});

// @test-kind security: a note attachment whose media type is not a valid one is served as application/octet-stream, stored or not.
test('a note attachment with a control character in its media type downloads as application/octet-stream', async (t) => {
  const { app, post, get } = await fixture(t);
  const state = app.store.snapshot();
  state.permissions = notesEditorPermissions();
  const seeded = 'a0000000-0000-4000-8000-0000000000b1';
  state.tables.annotation.push({
    annotationid: seeded,
    notetext: '*WEB*Seeded',
    subject: `Seeded [contact:${CONTACT}]`,
    objecttypecode: 'contact',
    objectid: { id: CONTACT, logical_name: 'contact' },
    filename: 'seeded.txt',
    mimetype: 'text/plain\r\nSet-Cookie: x=1',
    documentbody: Buffer.from('seeded').toString('base64'),
    createdon: '2026-01-02T03:04:05Z',
  });
  await app.store.replaceState(state);

  const added = await post('entity-form-addnote', {
    regardingEntityLogicalName: 'contact',
    regardingEntityId: CONTACT,
    text: 'Typed note',
    file: {
      name: 'typed.txt',
      type: 'text/plain\r\nSet-Cookie: x=1',
      content: Buffer.from('typed').toString('base64'),
    },
  });
  assert.equal(added.status, 201);
  const { Id: id } = await added.json();
  for (const [noteId, body] of [
    [id, 'typed'],
    [seeded, 'seeded'],
  ]) {
    const download = await get(`/_entity/annotation/${noteId}/${SITE}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.equal(await download.text(), body);
  }
});

// The anti-forgery check runs before the contact check, so an accepted token reaches SignInRequired for a request without a contact.
async function postNoteForm(t, context, token) {
  const server = http.createServer(async (req, res) => {
    if (!(await handleNativeService(req, res, new URL(req.url, 'http://127.0.0.1'), context))) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/_services/entity-form-addnote/${SITE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      regardingEntityLogicalName: 'contact',
      regardingEntityId: CONTACT,
      text: 'Admin note',
      __RequestVerificationToken: token,
    }),
  });
  return { status: response.status, body: await response.text() };
}

// @test-kind contract+security: the admin token is accepted as a native note form's anti-forgery field
// only when the context names it.
test('a native note form carrying the admin token passes the anti-forgery check only when the context names it', async (t) => {
  const context = { portal: { website: { id: SITE } }, csrf: 'page-token' };
  const configured = await postNoteForm(t, { ...context, adminToken: 'admin-token' }, 'admin-token');
  assert.equal(configured.status, 401);
  assert.match(configured.body, /SignInRequired/);
  const unconfigured = await postNoteForm(t, context, 'admin-token');
  assert.equal(unconfigured.status, 403);
  assert.match(unconfigured.body, /MissingPortalRequestVerificationToken/);
});

// @test-kind security: a near-miss anti-forgery token is refused
test('a note form token of the page or admin token length must match exactly, and each exact token passes', async (t) => {
  const context = { portal: { website: { id: SITE } }, csrf: 'page-token', adminToken: 'admin-token' };
  for (const token of ['page-tokeN', 'page', 'admin-tokeN', 'admin']) {
    const refused = await postNoteForm(t, context, token);
    assert.equal(refused.status, 403, token);
    assert.match(refused.body, /MissingPortalRequestVerificationToken/, token);
  }
  assert.equal((await postNoteForm(t, context, 'page-token')).status, 401);
  assert.equal((await postNoteForm(t, context, 'admin-token')).status, 401);
});

// @test-kind security: a near-miss anti-forgery header is refused
test('a JSON service post whose anti-forgery header is a near miss is refused, and the exact header is accepted', async () => {
  const { app, post } = shared;
  const nearMiss = app.csrf.slice(0, -1) + (app.csrf.endsWith('0') ? '1' : '0');
  const body = { regarding: { LogicalName: 'contact', Id: CONTACT }, page: 1, pageSize: 10 };
  for (const token of [nearMiss, 'short']) {
    const refused = await post('entity-notes', body, { __RequestVerificationToken: token });
    assert.equal(refused.status, 403, token.length);
    assert.match(await refused.text(), /MissingPortalRequestVerificationToken/);
  }
  assert.equal((await post('entity-notes', body)).status, 200);
});

// @test-kind compatibility: names from the Microsoft Learn AttributeTypeDisplayName class (https://learn.microsoft.com/dotnet/api/microsoft.xrm.sdk.metadata.attributetypedisplayname?view=dataverse-sdk-latest), documentation-derived and not a capture
test('a column without solution metadata reports the documented AttributeTypeDisplayName of its type', () => {
  const documented = {
    nvarchar: 'StringType',
    string: 'StringType',
    memo: 'MemoType',
    ntext: 'MemoType',
    int: 'IntegerType',
    integer: 'IntegerType',
    bigint: 'BigIntType',
    decimal: 'DecimalType',
    float: 'DoubleType',
    double: 'DoubleType',
    money: 'MoneyType',
    bit: 'BooleanType',
    boolean: 'BooleanType',
    datetime: 'DateTimeType',
    lookup: 'LookupType',
    customer: 'CustomerType',
    owner: 'OwnerType',
    picklist: 'PicklistType',
    state: 'StateType',
    status: 'StatusType',
    uniqueidentifier: 'UniqueidentifierType',
    primarykey: 'UniqueidentifierType',
    multiselectpicklist: 'MultiSelectPicklistType',
  };
  const actual = Object.fromEntries(
    Object.keys(documented).map((dataverseType) => [
      dataverseType,
      attributeEntry('col', '1', {
        field: { dataverseType },
        settings: {},
        entity: 'item',
        primaryName: 'name',
      }).AttributeMetadata.AttributeTypeName.Value,
    ]),
  );
  assert.deepEqual(actual, documented);
});

// @test-kind contract: the compact column metadata takes its numeric AttributeType and its AttributeTypeName from the one attribute type table, so the grid and the Liquid attribute_type name each internal type the same way.
test('a column without solution metadata reports the table numeric AttributeType and display name of every internal type', () => {
  for (const dataverseType of Object.keys(ATTRIBUTE_TYPE_NAMES)) {
    const metadata = attributeEntry('col', '1', {
      field: { dataverseType },
      settings: {},
      entity: 'item',
      primaryName: 'name',
    }).AttributeMetadata;
    assert.equal(metadata.AttributeType, attributeTypeNumber(dataverseType), dataverseType);
    assert.equal(metadata.AttributeTypeName.Value, attributeTypeDisplayName(dataverseType), dataverseType);
    assert.equal(attributeTypeCode(dataverseType), ATTRIBUTE_TYPE_NAMES[dataverseType][0], dataverseType);
  }
});

// @test-kind compatibility: the numeric value of every AttributeTypeCode name the attribute type table uses, as the AttributeTypeCode enum page of Microsoft Learn lists them (https://learn.microsoft.com/dotnet/api/microsoft.xrm.sdk.metadata.attributetypecode?view=dataverse-sdk-latest)
test('the attribute type table uses the AttributeTypeCode values that Microsoft Learn publishes', () => {
  const published = {
    Boolean: 0,
    Customer: 1,
    DateTime: 2,
    Decimal: 3,
    Double: 4,
    Integer: 5,
    Lookup: 6,
    Memo: 7,
    Money: 8,
    Owner: 9,
    PartyList: 10,
    Picklist: 11,
    State: 12,
    Status: 13,
    String: 14,
    Uniqueidentifier: 15,
    CalendarRules: 16,
    Virtual: 17,
    BigInt: 18,
    ManagedProperty: 19,
    EntityName: 20,
  };
  const used = new Set();
  for (const dataverseType of Object.keys(ATTRIBUTE_TYPE_NAMES)) {
    const code = attributeTypeCode(dataverseType);
    used.add(code);
    assert.equal(attributeTypeNumber(dataverseType), published[code], `${dataverseType} as ${code}`);
  }
  assert.deepEqual(
    [...used].toSorted((a, b) => a.localeCompare(b)),
    Object.keys(published)
      .filter((name) => name !== 'CalendarRules')
      .toSorted((a, b) => a.localeCompare(b)),
  );
});
