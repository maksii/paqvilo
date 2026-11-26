// @test-kind contract: the Power Pages document control answers the documented operations, permissions and verification token checks as the designed local runtime does.
// Power Pages document control at contract: the documented operations under
// the local /_apps/portal-documents/ route, the parent and Document Location table permissions, the SharePoint upload size
// settings and the 501 answer without storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { EXTENSION, createPortalDocumentService, PORTAL_DOCUMENTS_ROUTE } from '../lib/sharepoint-documents.mjs';
import { portalDocumentAccess } from '../lib/permissions.mjs';
import { createLocalDiskStorage } from '../lib/storage-local-disk.mjs';
import { createStorageRouter, ProviderError, storageSettings } from '../lib/storage-provider.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const CASE = '77777777-7777-4777-8777-777777777760';
const SITE = '77777777-7777-4777-8777-777777777761';
const CONTACT = '77777777-7777-4777-8777-777777777762';
const CSRF = 'invented-token';
const mappings = {
  x_case: {
    logicalName: 'x_case',
    entitySet: 'x_cases',
    idColumn: 'x_caseid',
    nameColumn: 'x_name',
    fields: { x_name: { dataverseType: 'nvarchar' } },
  },
};
const tables = {
  x_case: [{ x_caseid: CASE, x_name: 'Invented case', statecode: 0, statuscode: 1 }],
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

async function documents(
  t,
  { permissions, settings = {}, withStorage = true, wrapStorage = (provider) => provider } = {},
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
  const service = createPortalDocumentService({
    sharepoint: api.sharepoint,
    store,
    portal: () => ({ settings }),
    access: portalDocumentAccess,
    blockedExtensions: () => ['exe'],
  });
  const identity = { id: CONTACT, contactId: CONTACT, roles: ['Member'] };
  const server = http.createServer(async (req, res) => {
    if (!(await service.handle(req, res, new URL(req.url, 'http://127.0.0.1'), { identity, csrf: CSRF }))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  owner.add(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}${PORTAL_DOCUMENTS_ROUTE}x_case/${CASE}`;
  const call = (method, suffix = '', body, headers = {}) =>
    fetch(base + suffix, {
      method,
      body,
      headers: { ...(method === 'GET' ? {} : { __RequestVerificationToken: CSRF }), ...headers },
    });
  return { call, store };
}

// @test-kind security: a visitor without the Document Location permission cannot list documents
test('without the child Document Location permission the list is denied', async (t) => {
  const { call } = await documents(t, { permissions: [parent(['read', 'appendTo'])] });
  const response = await call('GET');
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'PermissionDenied');
});

// @test-kind security: a read-only visitor cannot upload
test('read-only permissions list documents but refuse an upload with 403', async (t) => {
  const { call } = await documents(t, { permissions: [parent(['read', 'appendTo']), child(['read'])] });
  const listed = await (await call('GET')).json();
  assert.deepEqual(listed, {
    folder: '',
    folders: [],
    documents: [],
    canUpload: false,
    canCreateFolder: false,
    canDelete: false,
  });
  assert.equal((await call('POST', '?name=a.txt', 'hello', { 'content-type': 'text/plain' })).status, 403);
  // New folder needs the upload privileges (Create, Write and Append on Document Location).
  assert.equal((await call('POST', '?newFolder=Contracts')).status, 403);
});

// @test-kind security: a traversal in ?folder= is refused with 400 on every method and named as an invalid folder path
test('a ?folder= path traversal is refused and named as an invalid folder path', async (t) => {
  const all = [parent(['read', 'appendTo', 'update']), child(['read', 'create', 'update', 'append', 'delete'])];
  const { call } = await documents(t, { permissions: all });
  assert.equal((await call('POST', '?newFolder=Contracts')).status, 201);
  for (const [method, traversal] of [
    ['GET', '?folder=..'],
    ['GET', '?folder=Contracts/..'],
    ['GET', '/signed.txt?folder=..'],
    ['POST', '?folder=..&name=x.txt'],
    ['POST', '?folder=..&newFolder=x'],
    ['DELETE', '?folder=Contracts/..'],
  ]) {
    const refused = await call(method, traversal, method === 'POST' ? 'x' : undefined);
    assert.equal(refused.status, 400, `${method} ${traversal}`);
    const body = await refused.json();
    assert.equal(body.error.code, 'SharePointInvalidName');
    assert.match(body.error.message, /^The folder path is not valid: .*path traversal is refused/, traversal);
  }
});

test('New folder, navigation, upload, download and delete inside subfolders (Learn: users can create subfolders)', async (t) => {
  const all = [parent(['read', 'appendTo', 'update']), child(['read', 'create', 'update', 'append', 'delete'])];
  const { call, store } = await documents(t, { permissions: all });
  const created = await call('POST', '?newFolder=Contracts');
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json().then(({ name, folder }) => ({ name, folder })), {
    name: 'Contracts',
    folder: true,
  });
  assert.equal(
    store.state.tables.sharepointdocumentlocation.filter((row) => row.regardingobjectid?.id === CASE).length,
    1,
    'the first folder creates the record location',
  );
  assert.equal((await call('POST', '?newFolder=Contracts')).status, 409);
  assert.equal((await call('POST', '?folder=Contracts&newFolder=2026')).status, 201);
  assert.equal(
    (await call('POST', '?folder=Contracts&name=signed.txt', 'signed', { 'content-type': 'text/plain' })).status,
    201,
  );
  assert.equal((await call('POST', '?name=root.txt', 'root')).status, 201);
  const root = await (await call('GET')).json();
  assert.deepEqual(
    [root.folders.map((item) => item.name), root.documents.map((item) => item.name), root.canCreateFolder],
    [['Contracts'], ['root.txt'], true],
  );
  const inside = await (await call('GET', '?folder=Contracts')).json();
  assert.deepEqual(
    [inside.folder, inside.folders.map((item) => item.name), inside.documents.map((item) => item.name)],
    ['Contracts', ['2026'], ['signed.txt']],
  );
  assert.equal(await (await call('GET', '/signed.txt?folder=Contracts')).text(), 'signed');
  assert.equal((await call('GET', '/signed.txt')).status, 404, 'a file is found in its own folder only');
  assert.equal((await call('GET', '?folder=Missing')).status, 404);
  assert.equal((await call('POST', '?folder=Missing&newFolder=x')).status, 404);
  for (const traversal of ['?folder=..', '?folder=Contracts/..', '?newFolder=..', '?newFolder=a%2Fb'])
    assert.equal((await call(traversal.includes('newFolder') ? 'POST' : 'GET', traversal)).status, 400, traversal);
  // SharePoint naming rules for new names, and one name per file or folder.
  for (const bad of ['a%3Ab', 'trail.', '%20lead', 'Docs%20', 'CON', 'desktop.ini', 'x%7Cy']) {
    assert.equal((await call('POST', `?newFolder=${bad}`)).status, 400, `folder ${bad}`);
    assert.equal((await call('POST', `?name=${bad}`, 'x')).status, 400, `file ${bad}`);
  }
  assert.equal((await call('POST', '?newFolder=root.txt')).status, 409, 'a folder beside a file of that name');
  assert.equal((await call('POST', '?name=Contracts', 'x')).status, 409, 'a file beside a folder of that name');
  // Every created folder stays addressable: the 16th level is the deepest.
  let deep = '';
  for (let level = 1; level <= 16; level++) {
    assert.equal(
      (await call('POST', `?${deep ? `folder=${deep}&` : ''}newFolder=L${level}`)).status,
      201,
      `level ${level}`,
    );
    deep = deep ? `${deep}/L${level}` : `L${level}`;
  }
  assert.equal((await call('GET', `?folder=${deep}`)).status, 200);
  assert.equal((await call('POST', `?folder=${deep}&newFolder=L17`)).status, 400);
  assert.equal((await call('DELETE', '?folder=L1')).status, 204);
  assert.equal((await call('DELETE', '/signed.txt?folder=Contracts')).status, 204);
  assert.equal((await call('DELETE', '?folder=Contracts')).status, 204);
  assert.deepEqual((await (await call('GET')).json()).folders, []);
  assert.equal((await call('GET', '?folder=Contracts/2026')).status, 404, 'a deleted folder takes its subfolders');
});

// @test-kind contract: a provider conflict preserves the portal duplicate-folder response and winning metadata
test('concurrent portal creates of a folder with case-equivalent names return Created and Conflict', async (t) => {
  const all = [parent(['read', 'appendTo', 'update']), child(['read', 'create', 'update', 'append'])];
  const arrived = Promise.withResolvers();
  let writes = 0;
  const { call } = await documents(t, {
    permissions: all,
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
  assert.equal((await call('POST', '?newFolder=Container')).status, 201);
  const responses = await Promise.all([
    call('POST', '?folder=Container&newFolder=Review'),
    call('POST', '?folder=Container&newFolder=review'),
  ]);
  assert.deepEqual(
    responses.map(({ status }) => status).sort((a, b) => a - b),
    [201, 409],
  );
  const [created, refused] = responses[0].status === 201 ? responses : responses.toReversed();
  assert.equal((await refused.json()).error.code, 'SharePointFolderExists');
  const winner = await created.json();
  const listed = await (await call('GET', '?folder=Container')).json();
  assert.deepEqual(listed.folders, [{ name: winner.name, lastModified: winner.lastModified }]);
});

// @test-kind contract: simultaneous provider-backed file and folder creates share the case-insensitive local namespace
test('concurrent portal file and folder creates with the same name return Created and Conflict', async (t) => {
  const scenarios = [
    { firstKind: 'file', failure: false, statuses: [201, 409], names: [[], ['REVIEW']] },
    { firstKind: 'folder', failure: false, statuses: [201, 409], names: [['Review'], []] },
    { firstKind: 'folder', failure: true, statuses: [503, 201], names: [[], ['REVIEW']] },
  ];
  for (const { firstKind, failure, statuses, names } of scenarios) {
    const detail = failure ? ' and fails' : '';
    await t.test(`${firstKind} starts first${detail}`, async (t) => {
      const all = [parent(['read', 'appendTo', 'update']), child(['read', 'create', 'update', 'append'])];
      const fileWrite = '?folder=Container&name=REVIEW';
      const folderWrite = '?folder=Container&newFolder=Review';
      const first = firstKind === 'file' ? fileWrite : folderWrite;
      const second = firstKind === 'file' ? folderWrite : fileWrite;
      const firstKey = firstKind === 'file' ? '/container/review' : '/container/review/_folder';
      const firstPut = Promise.withResolvers();
      const secondAdmitted = Promise.withResolvers();
      const releaseFirst = Promise.withResolvers();
      let firstReachedProvider = false;
      const { call } = await documents(t, {
        permissions: all,
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
      assert.equal((await call('POST', '?newFolder=Container')).status, 201);
      const start = (suffix) => call('POST', suffix, suffix === fileWrite ? 'payload' : undefined);
      const pendingFirst = start(first);
      await firstPut.promise;
      const pendingSecond = start(second);
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
      assert.equal((await refused.json()).error.code, failure ? 'Unavailable' : 'SharePointNameExists');
      const listed = await (await call('GET', '?folder=Container')).json();
      assert.deepEqual([listed.folders.map(({ name }) => name), listed.documents.map(({ name }) => name)], names);
    });
  }
});

// @test-kind security: each document operation requires its permission and an upload is capped by the size setting
test('upload, list, download and delete follow the documented permissions; the size setting bounds an upload', async (t) => {
  const all = [parent(['read', 'appendTo', 'update']), child(['read', 'create', 'update', 'append', 'delete'])];
  const { call, store } = await documents(t, { permissions: all });
  assert.equal((await call('POST', '?name=report.txt', 'hello', { 'content-type': 'text/plain' })).status, 201);
  assert.equal(
    store.state.tables.sharepointdocumentlocation.filter((row) => row.regardingobjectid?.id === CASE).length,
    1,
  );
  const listed = await (await call('GET')).json();
  assert.deepEqual(
    [listed.documents.map((file) => [file.name, file.size]), listed.canUpload, listed.canDelete],
    [[['report.txt', 5]], true, true],
  );
  const download = await call('GET', '/report.txt');
  assert.equal(await download.text(), 'hello');
  assert.equal((await call('POST', '?name=tool.exe', 'x')).status, 400, 'blocked extension');
  assert.equal((await call('POST', '?name=report.txt', 'hello')).status, 201);
  assert.equal((await call('POST', '', 'x', {})).status, 400, 'a name is required');
  assert.equal((await call('POST', '?name=x.txt', 'x', { __RequestVerificationToken: 'wrong' })).status, 403);
  assert.equal((await call('DELETE', '/report.txt')).status, 204);
  assert.deepEqual((await (await call('GET')).json()).documents, []);
  // Default SharePoint/MaxUploadSize: 10 MB.
  assert.equal((await call('POST', '?name=big.bin', Buffer.alloc(11 * 1048576))).status, 413);
  // New folder is served (?newFolder=, see the subfolder test); undocumented members still answer 501.
  assert.equal((await call('POST', '?newFolder=Invoices')).status, 201);
  assert.equal((await call('POST', '/folders/new')).status, 501);
  assert.equal((await call('PUT', '/report.txt')).status, 501);
});

test('SharePoint/MaxUploadSize raises the limit, and an unknown record is refused', async (t) => {
  const all = [parent(['read', 'appendTo', 'update']), child(['read', 'create', 'update', 'append', 'delete'])];
  const { call } = await documents(t, { permissions: all, settings: { 'SharePoint/MaxUploadSize': '20' } });
  assert.equal((await call('POST', '?name=big.bin', Buffer.alloc(11 * 1048576))).status, 201);
  const missing = await fetch((await call('GET')).url.replace(CASE, '77777777-7777-4777-8777-777777777769'));
  assert.equal(missing.status, 404);
});

test('without storage the service answers 501, never an empty list', async (t) => {
  const { call } = await documents(t, {
    permissions: [parent(['read', 'appendTo']), child(['read'])],
    withStorage: false,
  });
  const response = await call('GET');
  assert.equal(response.status, 501);
  assert.equal((await response.json()).error.code, 'SharePointStorageNotConfigured');
});

// @test-kind security: a near-miss verification token is refused
test('a write whose verification token is a near miss of the portal token is refused, and the exact token is accepted', async (t) => {
  const { call } = await documents(t, {
    permissions: [parent(['read', 'appendTo', 'update']), child(['read', 'create', 'update', 'append', 'delete'])],
  });
  const nearMiss = CSRF.slice(0, -1) + (CSRF.endsWith('x') ? 'y' : 'x');
  assert.equal(nearMiss.length, CSRF.length);
  assert.equal((await call('POST', '?name=x.txt', 'x', { __RequestVerificationToken: nearMiss })).status, 403);
  assert.equal((await call('POST', '?name=x.txt', 'x', { __RequestVerificationToken: 'short' })).status, 403);
  assert.equal((await call('POST', '?name=x.txt', 'x')).status, 201);
});
