// @test-kind contract: the Power Pages document control's services keep the documented permissions, verification token checks and folder rules over the local storage route.
// Power Pages document control over the /_services/sharepoint-* services (sharepoint-documents.mjs
// createPortalDocumentService): the parent and Document Location table permissions, the anti-forgery token, the SharePoint
// upload size settings, subfolders, and the failure shapes and check order hosted session F7 recorded with the integration
// off (D:\Repos\paqvilo-developer\hosted-f7\.paqvilo\evidence\summary-F7.md, runs/{a,b}/direct-*.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  EXTENSION,
  createPortalDocumentService,
  PORTAL_DOCUMENTS_ROUTE,
  sharePointControlMarkup,
} from '../lib/sharepoint-documents.mjs';
import { portalDocumentAccess } from '../lib/permissions.mjs';
import { createLocalDiskStorage } from '../lib/storage-local-disk.mjs';
import { createStorageRouter, ProviderError, storageSettings } from '../lib/storage-provider.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const CASE = '77777777-7777-4777-8777-777777777760';
const SITE = '77777777-7777-4777-8777-777777777761';
const CONTACT = '77777777-7777-4777-8777-777777777762';
const WEBSITE = '77777777-7777-4777-8777-777777777763';
const MISSING = '77777777-7777-4777-8777-777777777769';
const CSRF = 'invented-token';
const ORIGIN = 'http://portal.invented.test';
const mappings = {
  x_case: {
    logicalName: 'x_case',
    entitySet: 'x_cases',
    idColumn: 'x_caseid',
    nameColumn: 'x_name',
    fields: { x_name: { dataverseType: 'nvarchar' } },
  },
  x_other: { logicalName: 'x_other', entitySet: 'x_others', idColumn: 'x_otherid', nameColumn: 'x_name', fields: {} },
};
const OTHER = '77777777-7777-4777-8777-777777777764';
const tables = {
  x_case: [{ x_caseid: CASE, x_name: 'Invented case', statecode: 0, statuscode: 1 }],
  x_other: [{ x_otherid: OTHER, x_name: 'Invented other', statecode: 0, statuscode: 1 }],
  sharepointsite: [
    {
      sharepointsiteid: SITE,
      name: 'Default Site',
      absoluteurl: 'https://site.example.test/sites/invented',
      isdefault: true,
      statecode: 0,
      statuscode: 1,
    },
  ],
};
const parent = (operations) => ({ id: 'case', entity: 'x_case', scope: 'global', roles: ['Member'], operations });
const child = (operations) => ({
  id: 'docs',
  entity: 'sharepointdocumentlocation',
  scope: 'parent',
  roles: ['Member'],
  operations,
  parentPermissionId: 'case',
  relationship: { entity: 'x_case', from: 'regardingobjectid', to: 'x_caseid' },
});
const ALL = [parent(['read', 'appendTo', 'update']), child(['read', 'create', 'update', 'append', 'delete'])];
const READ = [parent(['read', 'appendTo', 'update']), child(['read'])];
const NONE = [parent(['read', 'appendTo', 'update'])];

const regarding = { Id: CASE, LogicalName: 'x_case', Name: null, KeyAttributes: [], RowVersion: null };
const NOT_ENABLED = 'SharePoint integration is not enabled. Please contact your system administrator for more details.';
const WRITE_DENIED = 'Permission denied. You do not have the appropriate table permissions to write SharePoint files.';
const DELETE_DENIED = 'Permission denied. You do not have the appropriate table permissions to delete this record.';

async function documents(
  t,
  {
    permissions,
    settings = {},
    withStorage = true,
    observed = null,
    wrapStorage = (provider) => provider,
    wrapSharepoint = (sharepoint) => sharepoint,
    diagnostic = null,
  } = {},
) {
  const owner = ownedFixture(t);
  let storage, local;
  if (withStorage) {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-documents-'));
    owner.remove(() => fs.rm(root, { recursive: true, force: true }));
    local = createLocalDiskStorage({ root });
    storage = createStorageRouter({ config: storageSettings({}), providers: { local: wrapStorage(local) } });
  }
  // The organization and its API close before the storage they write to, and that storage before its directory goes.
  const { api, store } = await contractModuleFixture(
    { after: (callback) => owner.add(callback) },
    { mappings, tables, extension: EXTENSION, options: { storage } },
  );
  if (local) owner.add(() => local.close());
  store.state.permissions = permissions;
  store.state.settings = { ...store.state.settings, permissionMode: 'enforce' };
  if (observed) store.observed = observed;
  const service = createPortalDocumentService({
    sharepoint: wrapSharepoint(api.sharepoint),
    store,
    portal: () => ({ settings }),
    access: portalDocumentAccess,
    blockedExtensions: () => ['exe'],
    diagnostic,
  });
  const identity = { id: CONTACT, contactId: CONTACT, roles: ['Member'] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!(await service.handle(req, res, url, { identity, csrf: CSRF, origin: ORIGIN }))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  owner.add(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const AJAX = { 'x-requested-with': 'XMLHttpRequest', __RequestVerificationToken: CSRF };
  const post = (service_, body, headers = AJAX) =>
    fetch(`${base}/_services/sharepoint-${service_}/${WEBSITE}`, {
      method: 'POST',
      redirect: 'manual',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
    });
  const list = (folderPath = '', extra = {}) =>
    post('data.json', { regarding, sortExpression: 'FileLeafRef ASC', page: 1, pageSize: 10, folderPath, ...extra });
  const names = async (folderPath = '') => {
    const answer = await (await list(folderPath)).json();
    return {
      folders: answer.SharePointItems.filter((item) => item.IsFolder).map((item) => item.Name),
      files: answer.SharePointItems.filter((item) => !item.IsFolder).map((item) => item.Name),
    };
  };
  const addFolder = (name, folderPath = '', target = regarding) =>
    post('addfolder', { regarding: target, name, folderPath });
  const remove = (id, folderPath = '') => post('deleteitem', { regarding, id, folderPath });
  // Add files as the control posts it: the regarding fields, one `files` part per file, overwrite and the token field.
  const addFiles = (files, { folderPath = '', overwrite = 'true', token = CSRF, id = CASE } = {}) => {
    const form = new FormData();
    form.append('regardingEntityLogicalName', 'x_case');
    form.append('regardingEntityId', id);
    for (const file of files)
      form.append('files', new Blob([file.body ?? 'x'], { type: file.type ?? 'text/plain' }), file.name);
    form.append('overwrite', overwrite);
    if (folderPath) form.append('folderPath', folderPath);
    if (token != null) form.append('__RequestVerificationToken', token);
    return fetch(`${base}/_services/sharepoint-addfiles/${WEBSITE}`, {
      method: 'POST',
      body: form,
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
  };
  const download = (name, folder = '') =>
    fetch(
      `${base}${PORTAL_DOCUMENTS_ROUTE}x_case/${CASE}/${encodeURIComponent(name)}${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`,
    );
  return { base, post, list, names, addFolder, remove, addFiles, download, store, api };
}
const messageOf = async (response) => (await response.json()).Message;

// @test-kind security: a visitor without the Document Location permission cannot list documents
test('without the child Document Location permission the list is denied', async (t) => {
  const { list } = await documents(t, { permissions: [parent(['read', 'appendTo'])] });
  const response = await list();
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.equal(answer.AccessDenied, true);
  assert.deepEqual(answer.SharePointItems, []);
});

// @test-kind security: a read-only visitor cannot upload
test('read-only permissions list documents but refuse an upload and a new folder with 400', async (t) => {
  const { list, addFiles, addFolder } = await documents(t, {
    permissions: [parent(['read', 'appendTo']), child(['read'])],
  });
  assert.deepEqual(await (await list()).json(), {
    SharePointItems: [],
    PageSize: 10,
    PageNumber: 1,
    PagingInfo: null,
    TotalCount: 0,
    AccessDenied: false,
    ConfigError: false,
  });
  const upload = await addFiles([{ name: 'a.txt', body: 'hello' }]);
  assert.equal(upload.status, 400);
  assert.equal(await messageOf(upload), WRITE_DENIED);
  // New folder needs the upload privileges (Create, Write and Append on Document Location).
  const folder = await addFolder('Contracts');
  assert.equal(folder.status, 400);
  assert.equal(await messageOf(folder), WRITE_DENIED);
});

// @test-kind security: a traversal in a folder path is refused with 400 on every service and named as an invalid folder path
test('a folderPath traversal is refused and named as an invalid folder path', async (t) => {
  const { list, addFolder, addFiles, remove, download } = await documents(t, { permissions: ALL });
  assert.equal((await addFolder('Contracts')).status, 204);
  for (const [label, send] of [
    ['list ..', () => list('..')],
    ['list Contracts/..', () => list('Contracts/..')],
    ['download ..', () => download('signed.txt', '..')],
    ['add files ..', () => addFiles([{ name: 'x.txt' }], { folderPath: '..' })],
    ['new folder ..', () => addFolder('x', '..')],
    ['delete Contracts/..', () => remove('x', 'Contracts/..')],
  ]) {
    const refused = await send();
    assert.equal(refused.status, 400, label);
    const body = await refused.json();
    const text = body.Message ?? body.error?.message;
    if (body.error) assert.equal(body.error.code, 'SharePointInvalidName');
    assert.match(text, /^The folder path is not valid: .*path traversal is refused/, label);
  }
});

test('New folder, navigation, upload, download and delete inside subfolders (Learn: users can create subfolders)', async (t) => {
  const { list, names, addFolder, addFiles, remove, download, store } = await documents(t, { permissions: ALL });
  assert.equal((await addFolder('Contracts')).status, 204);
  assert.equal(
    store.state.tables.sharepointdocumentlocation.filter((row) => row.regardingobjectid?.id === CASE).length,
    1,
    'the first folder creates the record location',
  );
  assert.equal((await addFolder('Contracts')).status, 409);
  assert.equal((await addFolder('2026', 'Contracts')).status, 204);
  assert.equal((await addFiles([{ name: 'signed.txt', body: 'signed' }], { folderPath: 'Contracts' })).status, 204);
  assert.equal((await addFiles([{ name: 'root.txt', body: 'root' }])).status, 204);
  assert.deepEqual(await names(), { folders: ['Contracts'], files: ['root.txt'] });
  const inside = await (await list('Contracts')).json();
  assert.deepEqual(
    inside.SharePointItems.map(({ Name, IsFolder, FolderPath, Url }) => [Name, IsFolder, FolderPath, Url]),
    [
      ['2026', true, 'Contracts/2026', null],
      ['signed.txt', false, 'Contracts', `${PORTAL_DOCUMENTS_ROUTE}x_case/${CASE}/signed.txt?folder=Contracts`],
    ],
  );
  assert.equal(await (await download('signed.txt', 'Contracts')).text(), 'signed');
  assert.equal((await download('signed.txt')).status, 404, 'a file is found in its own folder only');
  assert.equal((await list('Missing')).status, 404);
  assert.equal((await addFolder('x', 'Missing')).status, 404);
  for (const [label, send] of [
    ['list ..', () => list('..')],
    ['list Contracts/..', () => list('Contracts/..')],
    ['new folder ..', () => addFolder('..')],
    ['new folder a/b', () => addFolder('a/b')],
  ])
    assert.equal((await send()).status, 400, label);
  // SharePoint naming rules for new names, and one name per file or folder.
  for (const bad of ['a:b', 'trail.', ' lead', 'Docs ', 'CON', 'desktop.ini', 'x|y']) {
    assert.equal((await addFolder(bad)).status, 400, `folder ${bad}`);
    assert.equal((await addFiles([{ name: bad }])).status, 400, `file ${bad}`);
  }
  assert.equal((await addFolder('root.txt')).status, 409, 'a folder beside a file of that name');
  assert.equal((await addFiles([{ name: 'Contracts' }])).status, 409, 'a file beside a folder of that name');
  // Every created folder stays addressable: the 16th level is the deepest.
  let deep = '';
  for (let level = 1; level <= 16; level++) {
    assert.equal((await addFolder(`L${level}`, deep)).status, 204, `level ${level}`);
    deep = deep ? `${deep}/L${level}` : `L${level}`;
  }
  assert.equal((await list(deep)).status, 200);
  assert.equal((await addFolder('L17', deep)).status, 400);
  assert.equal((await remove('L1')).status, 204);
  assert.equal((await remove('signed.txt', 'Contracts')).status, 204);
  assert.equal((await remove('Contracts')).status, 204);
  assert.deepEqual((await names()).folders, []);
  assert.equal((await list('Contracts/2026')).status, 404, 'a deleted folder takes its subfolders');
});

// @test-kind contract: a provider conflict preserves the portal duplicate-folder response and winning metadata
test('concurrent portal creates of a folder with case-equivalent names return success and Conflict', async (t) => {
  const arrived = Promise.withResolvers();
  let writes = 0;
  const { addFolder, names } = await documents(t, {
    permissions: [parent(['read', 'appendTo', 'update']), child(['read', 'create', 'update', 'append'])],
    wrapStorage: (provider) => ({
      ...provider,
      async put(key, body, options) {
        if (key.endsWith('/review/_folder')) {
          if (++writes === 2) arrived.resolve();
          await arrived.promise;
        }
        return provider.put(key, body, options);
      },
    }),
  });
  assert.equal((await addFolder('Container')).status, 204);
  const responses = await Promise.all([addFolder('Review', 'Container'), addFolder('review', 'Container')]);
  assert.deepEqual(
    responses.map(({ status }) => status).sort((a, b) => a - b),
    [204, 409],
  );
  const winner = responses[0].status === 204 ? 'Review' : 'review';
  const refused = responses.find(({ status }) => status === 409);
  assert.match(await messageOf(refused), /^A folder named '(Review|review)' already exists\.$/);
  assert.deepEqual((await names('Container')).folders, [winner]);
});

// @test-kind contract: simultaneous provider-backed file and folder creates share the case-insensitive local namespace
test('concurrent portal file and folder creates with the same name return success and Conflict', async (t) => {
  const scenarios = [
    { firstKind: 'file', failure: false, statuses: [204, 409], listed: { folders: [], files: ['REVIEW'] } },
    { firstKind: 'folder', failure: false, statuses: [204, 409], listed: { folders: ['Review'], files: [] } },
    { firstKind: 'folder', failure: true, statuses: [503, 204], listed: { folders: [], files: ['REVIEW'] } },
  ];
  for (const { firstKind, failure, statuses, listed } of scenarios) {
    const detail = failure ? ' and fails' : '';
    await t.test(`${firstKind} starts first${detail}`, async (t) => {
      const firstKey = firstKind === 'file' ? '/container/review' : '/container/review/_folder';
      const firstPut = Promise.withResolvers();
      const secondAdmitted = Promise.withResolvers();
      const releaseFirst = Promise.withResolvers();
      let firstReachedProvider = false;
      const { addFolder, addFiles, names } = await documents(t, {
        permissions: [parent(['read', 'appendTo', 'update']), child(['read', 'create', 'update', 'append'])],
        wrapStorage: (provider) => ({
          ...provider,
          async head(key) {
            const found = await provider.head(key);
            if (firstReachedProvider && key.endsWith('/container/_folder')) secondAdmitted.resolve();
            return found;
          },
          async put(key, body, options) {
            if (key.endsWith(firstKey)) {
              firstReachedProvider = true;
              firstPut.resolve();
              await releaseFirst.promise;
              if (failure) throw new ProviderError('Unavailable', 'Invented provider failure.');
            }
            return provider.put(key, body, options);
          },
        }),
      });
      assert.equal((await addFolder('Container')).status, 204);
      const fileWrite = () => addFiles([{ name: 'REVIEW', body: 'payload' }], { folderPath: 'Container' });
      const folderWrite = () => addFolder('Review', 'Container');
      const [first, second] = firstKind === 'file' ? [fileWrite, folderWrite] : [folderWrite, fileWrite];
      const pendingFirst = first();
      await firstPut.promise;
      const pendingSecond = second();
      try {
        await secondAdmitted.promise;
        // Let the competing handler proceed from its parent lookup while the first provider write is suspended.
        await nextTurn();
      } finally {
        releaseFirst.resolve();
      }
      const [firstAnswer, secondAnswer] = await Promise.all([pendingFirst, pendingSecond]);
      assert.deepEqual([firstAnswer.status, secondAnswer.status], statuses);
      const refused = failure ? firstAnswer : secondAnswer;
      assert.equal(
        await messageOf(refused),
        failure ? 'Invented provider failure.' : 'A file or folder with this name already exists.',
      );
      assert.deepEqual(await names('Container'), listed);
    });
  }
});

// @test-kind security: each document operation requires its permission and an upload is capped by the size setting
test('upload, list, download and delete follow the documented permissions; the size setting bounds an upload', async (t) => {
  const { list, addFiles, addFolder, remove, download, store, base } = await documents(t, { permissions: ALL });
  assert.equal((await addFiles([{ name: 'report.txt', body: 'hello' }])).status, 204);
  assert.equal(
    store.state.tables.sharepointdocumentlocation.filter((row) => row.regardingobjectid?.id === CASE).length,
    1,
  );
  const listed = await (await list()).json();
  assert.deepEqual(
    listed.SharePointItems.map(({ Id, Name, FileSizeDisplay }) => [Id, Name, FileSizeDisplay]),
    [['report.txt', 'report.txt', '1 KB']],
  );
  assert.equal(await (await download('report.txt')).text(), 'hello');
  assert.equal((await addFiles([{ name: 'tool.exe' }])).status, 400, 'blocked extension');
  assert.equal((await addFiles([{ name: 'report.txt', body: 'hello' }])).status, 204, 'overwrite');
  assert.equal(
    (await addFiles([{ name: 'report.txt', body: 'hello' }], { overwrite: 'false' })).status,
    409,
    'no overwrite',
  );
  assert.equal((await addFiles([{ name: 'x.txt' }], { token: 'wrong' })).status, 500);
  assert.equal((await remove('report.txt')).status, 204);
  assert.deepEqual((await (await list()).json()).SharePointItems, []);
  // Default SharePoint/MaxUploadSize: 10 MB.
  assert.equal((await addFiles([{ name: 'big.bin', body: Buffer.alloc(11 * 1048576) }])).status, 413);
  assert.equal((await addFolder('Invoices')).status, 204);
  // The local download route serves only a file's bytes.
  assert.equal((await fetch(`${base}${PORTAL_DOCUMENTS_ROUTE}x_case/${CASE}`)).status, 501);
  assert.equal((await fetch(`${base}${PORTAL_DOCUMENTS_ROUTE}x_case/${CASE}/a.txt`, { method: 'DELETE' })).status, 501);
});

test('SharePoint/MaxUploadSize raises the limit, and an unknown record is refused', async (t) => {
  const { addFiles } = await documents(t, { permissions: ALL, settings: { 'SharePoint/MaxUploadSize': '20' } });
  assert.equal((await addFiles([{ name: 'big.bin', body: Buffer.alloc(11 * 1048576) }])).status, 204);
  const missing = await addFiles([{ name: 'a.txt' }], { id: MISSING });
  assert.equal(missing.status, 500);
  assert.equal(await messageOf(missing), 'Sequence contains no elements');
});

// @test-kind security: a near-miss verification token is refused
test('a write whose verification token is a near miss of the portal token is refused, and the exact token is accepted', async (t) => {
  const { addFiles } = await documents(t, { permissions: ALL });
  const nearMiss = CSRF.slice(0, -1) + (CSRF.endsWith('x') ? 'y' : 'x');
  assert.equal(nearMiss.length, CSRF.length);
  for (const token of [nearMiss, 'short', null]) {
    const refused = await addFiles([{ name: 'x.txt' }], { token });
    assert.equal(refused.status, 500, String(token));
    assert.match(refused.headers.get('content-type'), /^text\/html/);
  }
  assert.equal((await addFiles([{ name: 'x.txt' }])).status, 204);
});

// ---- Hosted session F7 (integration off): failure shapes and check order

// @test-kind observation: F7 runs a and b, direct-s0/-s1/-s1-loc.json, full child permission, integration off: every service answers 500 "not enabled"; a GET answers 404 empty; another website id answers alike
test('F7: with the integration off every service answers 500 not enabled after the record checks', async (t) => {
  for (const variant of [{ withStorage: false }, { observed: { sharePointIntegration: 'off' } }]) {
    const { list, addFolder, remove, addFiles, base } = await documents(t, { permissions: ALL, ...variant });
    for (const [label, send] of [
      ['list', () => list()],
      ['list subfolder', () => list('sub', { sortExpression: 'Modified DESC' })],
      ['new folder', () => addFolder('f7 folder')],
      ['delete', () => remove(1)],
      ['add files', () => addFiles([{ name: 'note.txt' }])],
      ['add files .exe', () => addFiles([{ name: 'tool.exe' }])],
    ]) {
      const response = await send();
      assert.equal(response.status, 500, label);
      assert.match(response.headers.get('content-type'), /^application\/json; charset=utf-8$/, label);
      assert.deepEqual(await response.json(), { Message: NOT_ENABLED }, label);
    }
    const other = await fetch(`${base}/_services/sharepoint-data.json/00000000-0000-4000-8000-0000000000f7`, {
      method: 'POST',
      body: JSON.stringify({ regarding, sortExpression: 'FileLeafRef ASC', page: 1, pageSize: 10, folderPath: '' }),
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
        __RequestVerificationToken: CSRF,
      },
    });
    assert.deepEqual([other.status, await other.json()], [500, { Message: NOT_ENABLED }]);
    const get = await fetch(`${base}/_services/sharepoint-data.json/${WEBSITE}`);
    assert.deepEqual([get.status, await get.text()], [404, '']);
  }
});

// @test-kind security: F7 direct-s0.json data-no-token and data-not-ajax: a list without its anti-forgery token or X-Requested-With is refused as an authentication challenge, never answered
test('F7: a list without the token or X-Requested-With answers the sign-in challenge', async (t) => {
  const { post } = await documents(t, { permissions: ALL });
  const body = { regarding, sortExpression: 'FileLeafRef ASC', page: 1, pageSize: 10, folderPath: '' };
  const challenge = JSON.stringify({
    status: 401,
    headers: { location: `${ORIGIN}/SignIn?ReturnUrl=%2F_services%2Fsharepoint-data.json%2F${WEBSITE}` },
  });
  const noToken = await post('data.json', body, { 'x-requested-with': 'XMLHttpRequest' });
  assert.deepEqual(
    [noToken.status, noToken.headers.get('x-responded-json'), await noToken.text()],
    [200, challenge, ''],
  );
  const nearMiss = await post('data.json', body, {
    'x-requested-with': 'XMLHttpRequest',
    __RequestVerificationToken: CSRF.slice(0, -1) + 'x',
  });
  assert.deepEqual([nearMiss.status, nearMiss.headers.get('x-responded-json')], [200, challenge]);
  const notAjax = await post('data.json', body, { __RequestVerificationToken: CSRF });
  assert.deepEqual(
    [notAjax.status, notAjax.headers.get('location')],
    [302, `${ORIGIN}/SignIn?ReturnUrl=%2F_services%2Fsharepoint-data.json%2F${WEBSITE}`],
  );
});

// @test-kind observation: F7 direct-s0.json data-missing-record, data-other-table, data-no-regarding: a missing or unreadable record answers AccessDenied before the integration check; no regarding answers 500
test('F7: a list for a missing or unreadable record answers AccessDenied; no regarding answers 500', async (t) => {
  const { post } = await documents(t, { permissions: ALL, withStorage: false });
  const denied = {
    SharePointItems: [],
    PageSize: 10,
    PageNumber: 1,
    PagingInfo: null,
    TotalCount: 0,
    AccessDenied: true,
    ConfigError: false,
  };
  const page = { sortExpression: 'FileLeafRef ASC', page: 1, pageSize: 10, folderPath: '' };
  for (const target of [
    { ...regarding, Id: MISSING },
    { ...regarding, LogicalName: 'x_other', Id: OTHER },
  ]) {
    const response = await post('data.json', { regarding: target, ...page });
    assert.deepEqual([response.status, await response.json()], [200, denied], target.LogicalName);
  }
  const none = await post('data.json', page);
  assert.deepEqual(
    [none.status, await none.json()],
    [500, { Message: 'LogicalName is required when entity id is not specified' }],
  );
});

// @test-kind observation: F7 direct-s0.json addfolder-missing-record, addfolder-empty-name, addfiles-no-file, addfolder-no-token, deleteitem-no-token, addfiles-no-token (full permission, integration off)
test('F7: write checks before the integration: token, file, record and an empty folder name', async (t) => {
  const { post, addFolder, addFiles } = await documents(t, { permissions: ALL, withStorage: false });
  const missing = await addFolder('f7 folder', '', { ...regarding, Id: MISSING });
  assert.deepEqual([missing.status, await missing.json()], [500, { Message: 'Sequence contains no elements' }]);
  const empty = await addFolder('');
  assert.deepEqual([empty.status, await empty.text()], [204, '']);
  for (const [label, response] of [
    ['add files without a file', await addFiles([])],
    ['add files without a token', await addFiles([{ name: 'x.txt' }], { token: null })],
    [
      'new folder without a token',
      await post('addfolder', { regarding, name: 'x', folderPath: '' }, { 'x-requested-with': 'XMLHttpRequest' }),
    ],
    [
      'delete without a token',
      await post('deleteitem', { regarding, id: 1, folderPath: '' }, { 'x-requested-with': 'XMLHttpRequest' }),
    ],
  ]) {
    assert.equal(response.status, 500, label);
    assert.match(response.headers.get('content-type'), /^text\/html; charset=utf-8$/, label);
    assert.match(await response.text(), /<title>We're sorry, but something went wrong \(500\)<\/title>/, label);
  }
});

// @test-kind security: F7 direct-s0-read.json and direct-s0-none.json: with the Document Location child permission read or none, new folder, add files (an .exe too) and delete are refused with 400 before the integration check
test('F7: read or no child permission refuses every write with the platform permission messages', async (t) => {
  for (const permissions of [READ, NONE]) {
    const { list, addFolder, addFiles, remove } = await documents(t, { permissions, withStorage: false });
    for (const [label, response, text] of [
      ['new folder', await addFolder('f7 folder'), WRITE_DENIED],
      ['new folder with an empty name', await addFolder(''), WRITE_DENIED],
      ['add files', await addFiles([{ name: 'note.txt' }]), WRITE_DENIED],
      ['add files .exe', await addFiles([{ name: 'tool.exe' }]), WRITE_DENIED],
      ['delete', await remove(1), DELETE_DENIED],
    ])
      assert.deepEqual([response.status, await response.json()], [400, { Message: text }], label);
    // The list checks the record, then the integration: the child permission does not come first.
    const listed = await list();
    assert.deepEqual([listed.status, await listed.json()], [500, { Message: NOT_ENABLED }]);
  }
});

// ---- Review regressions

// @test-kind security: whether a record exists is not told by the answers: inferred (F7 recorded the missing record's 500 only for a visitor who reads the whole table), a visitor who does not read the whole table gets the permission answer for a missing record too, and the download route answers a missing record, an unlisted one and a missing file alike
test('a missing and an unreadable record answer alike unless the visitor reads the whole table', async (t) => {
  // Contact-scoped read: the visitor reads only the cases linked to it, so neither record below is readable.
  const scoped = [
    {
      id: 'case',
      entity: 'x_case',
      scope: 'contact',
      roles: ['Member'],
      operations: ['read', 'appendTo', 'update'],
      relationship: { from: 'x_contactid' },
    },
    child(['read', 'create', 'update', 'append', 'delete']),
  ];
  const { addFolder, addFiles, remove, base } = await documents(t, { permissions: scoped });
  const missing = { ...regarding, Id: MISSING };
  for (const [label, response, text] of [
    ['new folder, missing', await addFolder('x', '', missing), WRITE_DENIED],
    ['new folder, unreadable', await addFolder('x'), WRITE_DENIED],
    ['add files, missing', await addFiles([{ name: 'a.txt' }], { id: MISSING }), WRITE_DENIED],
    ['add files, unreadable', await addFiles([{ name: 'a.txt' }]), WRITE_DENIED],
    ['delete, unreadable', await remove('a.txt'), DELETE_DENIED],
    [
      'another table, missing',
      await addFolder('x', '', { ...regarding, LogicalName: 'x_other', Id: MISSING }),
      WRITE_DENIED,
    ],
    ['an unknown table', await addFolder('x', '', { ...regarding, LogicalName: 'x_unknown' }), WRITE_DENIED],
  ])
    assert.deepEqual([response.status, await response.json()], [400, { Message: text }], label);
  // The download route: one answer for a missing record, an unreadable one and an unknown table.
  const answers = [];
  for (const address of [`x_case/${MISSING}/a.txt`, `x_case/${CASE}/a.txt`, `x_unknown/${CASE}/a.txt`]) {
    const response = await fetch(`${base}${PORTAL_DOCUMENTS_ROUTE}${address}`);
    answers.push([response.status, await response.json()]);
  }
  const expected = [
    404,
    { error: { code: 'NotFound', message: "The document 'a.txt' does not exist in this location." } },
  ];
  assert.deepEqual(answers, [expected, expected, expected]);
});

// @test-kind security: a write's token header is checked before its body is read, and a declared length over the limit is refused before the body is read
test('a write is refused before its body is read', async (t) => {
  const { base } = await documents(t, { permissions: ALL });
  const open = (service, headers) =>
    new Promise((resolve, reject) => {
      const request = http.request(`${base}/_services/sharepoint-${service}/${WEBSITE}`, {
        method: 'POST',
        headers: { 'x-requested-with': 'XMLHttpRequest', ...headers },
      });
      request.on('response', (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          request.destroy();
          resolve({
            status: response.statusCode,
            type: response.headers['content-type'],
            body: Buffer.concat(chunks).toString(),
          });
        });
      });
      request.on('error', (error) => (error.code === 'ECONNRESET' ? undefined : reject(error)));
      // One chunk of a body that never ends: an answer proves the body was not awaited.
      request.write('{');
    });
  const forged = await open('addfolder', {
    'content-type': 'application/json',
    'content-length': String(1024 * 1024 - 1),
    __RequestVerificationToken: 'forged',
  });
  assert.equal(forged.status, 500);
  assert.match(forged.type, /^text\/html/);
  const forgedFiles = await open('addfiles', {
    'content-type': 'multipart/form-data; boundary=x',
    'content-length': String(1024 * 1024),
    __RequestVerificationToken: 'forged',
  });
  assert.equal(forgedFiles.status, 500);
  const large = await open('addfiles', {
    'content-type': 'multipart/form-data; boundary=x',
    'content-length': String(52 * 1048576),
    __RequestVerificationToken: CSRF,
  });
  assert.deepEqual(
    [large.status, JSON.parse(large.body)],
    [413, { Message: 'The files exceed the maximum total upload size of 50 MB.' }],
  );
  const unauthenticatedLarge = await open('addfiles', {
    'content-type': 'multipart/form-data; boundary=x',
    'content-length': String(52 * 1048576),
  });
  assert.equal(
    unauthenticatedLarge.status,
    413,
    'a header-less upload is bounded by its declared length before any read',
  );
});

// @test-kind observation: F7 view-s0-size.json and view-s0-size2.json (runs a and b): SharePoint/MaxUploadSize 60 rendered 50 and 5 rendered 5; SharePoint/MaxTotalUploadSize 20 and 7 rendered 50; the services enforce the limits the control renders (local)
test('the upload limits the control renders are the limits the services enforce', async (t) => {
  for (const [settings, file, total] of [
    [{}, 10, 50],
    [{ 'SharePoint/MaxUploadSize': '60', 'SharePoint/MaxTotalUploadSize': '20' }, 50, 50],
    [{ 'SharePoint/MaxUploadSize': '5', 'SharePoint/MaxTotalUploadSize': '7' }, 5, 50],
    [{ 'SharePoint/MaxTotalUploadSize': '70' }, 10, 70],
  ]) {
    const markup = sharePointControlMarkup({
      controlId: 'docs',
      entity: 'x_case',
      id: CASE,
      websiteId: WEBSITE,
      canAdd: true,
      canDelete: true,
      portal: { settings },
    });
    const [, renderedFile, renderedTotal] = /data-maxfileuploadsize="(\d+)" data-maxtotaluploadsize="(\d+)"/.exec(
      markup,
    );
    assert.deepEqual(
      { file: Number(renderedFile), total: Number(renderedTotal) },
      { file, total },
      JSON.stringify(settings),
    );
    assert.match(markup, new RegExp(`data-maxfileuploadsize="${file}" data-maxtotaluploadsize="${total}"`));
  }
  const files = (count) =>
    Array.from({ length: count }, (_, index) => ({ name: `part-${index}.bin`, body: Buffer.alloc(10 * 1048576) }));
  const defaults = await documents(t, { permissions: ALL });
  const over = await defaults.addFiles(files(6));
  assert.deepEqual(
    [over.status, await over.json()],
    [413, { Message: 'The files exceed the maximum total upload size of 50 MB.' }],
  );
  assert.deepEqual((await defaults.names()).files, [], 'nothing of a refused request is stored');
  const raised = await documents(t, { permissions: ALL, settings: { 'SharePoint/MaxTotalUploadSize': '70' } });
  assert.equal((await raised.addFiles(files(6))).status, 204);
  assert.equal((await raised.names()).files.length, 6);
});

// @test-kind security: a file name or a delete id with a path separator is refused with 400 and touches nothing outside the folder
test('a file name or a delete id ../x is refused', async (t) => {
  const { addFiles, remove, names } = await documents(t, { permissions: ALL });
  assert.equal((await addFiles([{ name: 'kept.txt' }])).status, 204);
  for (const name of ['../x', '..\\x', 'a/../../x'])
    assert.equal((await addFiles([{ name }])).status, 400, `file ${name}`);
  for (const id of ['../x', '../kept.txt', '..']) assert.equal((await remove(id)).status, 400, `delete ${id}`);
  assert.deepEqual((await names()).files, ['kept.txt']);
});

// @test-kind security: an unexpected failure answers a generic message; its detail stays in the local diagnostic
test('an unexpected failure does not send its detail to the visitor', async (t) => {
  const diagnostics = [];
  const { list, api } = await documents(t, {
    permissions: ALL,
    diagnostic: (entry) => diagnostics.push(entry),
    wrapSharepoint: (sharepoint) => ({
      ...sharepoint,
      listDocuments: async () => {
        throw new TypeError('invented internal detail');
      },
    }),
  });
  // The record needs a location for the listing to run.
  await api.sharepoint.ensureLocation({ logicalName: 'x_case', id: CASE }, {}, { admin: true });
  const response = await list();
  assert.deepEqual([response.status, await response.json()], [500, { Message: 'Error completing request.' }]);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'SHAREPOINT_SERVICE_FAILED');
  assert.match(diagnostics[0].message, /invented internal detail/);
});
