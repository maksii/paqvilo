// @test-kind contract: local SharePoint document storage, location transactions and provider failures
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EXTENSION } from '../lib/sharepoint-documents.mjs';
import { createLocalDiskStorage } from '../lib/storage-local-disk.mjs';
import { createStorageRouter, storageSettings } from '../lib/storage-provider.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { createScheduler, fixedClock } from '../lib/runtime-clock.mjs';

const CASE = '55555555-5555-4555-8555-555555555555';
const SITE = '66666666-6666-4666-8666-666666666666';
const NOBODY = '88888888-8888-4888-8888-888888888888'; // a systemuser with no roles
const ADMIN = { admin: true };
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
  x_case: [{ x_caseid: CASE, x_name: 'Invented: case', statecode: 0, statuscode: 1 }],
  sharepointsite: [
    {
      sharepointsiteid: SITE,
      name: 'Default Site',
      absoluteurl: 'https://site.example.test/sites/invented',
      isdefault: true,
      isgridpresent: true,
      statecode: 0,
      statuscode: 1,
    },
  ],
  systemuser: [{ systemuserid: NOBODY, fullname: 'Invented nobody', isdisabled: false, accessmode: 0 }],
};

async function setup(t, { withStorage = true, wrapStorage = (storage) => storage, shared = null } = {}) {
  const diagnostics = [];
  const owner = ownedFixture(t);
  let storage, local;
  if (shared) storage = createStorageRouter({ config: storageSettings({}), providers: { local: shared } });
  else if (withStorage) {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'sharepoint-documents-'));
    owner.remove(() => fs.rm(root, { recursive: true, force: true }));
    local = createLocalDiskStorage({ root });
    storage = createStorageRouter({ config: storageSettings({}), providers: { local: wrapStorage(local) } });
  }
  let api;
  // The fixture returns the HTTP handle; the wrapper keeps the internal api the module installs on.
  const extension = {
    ...EXTENSION,
    install: (internal, options) => {
      api = internal;
      return EXTENSION.install(internal, options);
    },
  };
  // The organization and its API close before the storage they write to, and that storage before its directory goes.
  const fixture = await contractModuleFixture(
    { after: (callback) => owner.add(callback) },
    { mappings, tables, extension, options: { storage, diagnostic: (entry) => diagnostics.push(entry) } },
  );
  if (local) owner.add(() => local.close());
  return { ...fixture, api, sp: api.sharepoint, diagnostics };
}

test('ensureLocation creates the library and record location rows and the folder, once', async (t) => {
  const { sp, store, request, json } = await setup(t);
  const location = await sp.ensureLocation({ logicalName: 'x_case', id: CASE }, {}, ADMIN);
  assert.equal(location.relativeurl, 'Invented case_55555555555545558555555555555555');
  assert.equal(location.regardingobjectid.id, CASE);
  assert.equal(location.parentsiteorlocation.logical_name, 'sharepointdocumentlocation');
  const again = await sp.ensureLocation({ logicalName: 'x_case', id: CASE }, {}, ADMIN);
  assert.equal(again.sharepointdocumentlocationid, location.sharepointdocumentlocationid);
  assert.equal(store.state.tables.sharepointdocumentlocation.length, 2);
  assert.equal((await sp.locationsFor({ logicalName: 'x_case', id: CASE }, ADMIN)).length, 1);
  assert.deepEqual(await sp.listDocuments(location.sharepointdocumentlocationid, ADMIN), []);
  // The rows compose with the existing RetrieveAbsoluteAndSiteCollectionUrl message.
  const urls = await json(
    await request(
      'GET',
      `/sharepointdocumentlocations(${location.sharepointdocumentlocationid})/Microsoft.Dynamics.CRM.RetrieveAbsoluteAndSiteCollectionUrl()`,
    ),
    200,
  );
  assert.equal(
    urls.AbsoluteUrl,
    'https://site.example.test/sites/invented/x_case/Invented case_55555555555545558555555555555555',
  );
});

test('concurrent ensureLocation calls for one record create one record location', async (t) => {
  const { sp, store } = await setup(t);
  const regarding = { logicalName: 'x_case', id: CASE };
  const [first, second] = await Promise.all([
    sp.ensureLocation(regarding, {}, ADMIN),
    sp.ensureLocation(regarding, {}, ADMIN),
  ]);
  assert.equal(first.sharepointdocumentlocationid, second.sharepointdocumentlocationid);
  assert.equal(store.state.tables.sharepointdocumentlocation.length, 2);
  assert.equal((await sp.locationsFor(regarding, ADMIN)).length, 1);
});

test('a failed provider deletion leaves the document folder addressable for retry', async (t) => {
  const providerError = new Error('Invented provider failure');
  let blocked = true;
  const { sp } = await setup(t, {
    wrapStorage: (provider) => ({
      ...provider,
      delete(key, options) {
        if (blocked && key.endsWith('/retry.txt')) throw providerError;
        return provider.delete(key, options);
      },
    }),
  });
  const { sharepointdocumentlocationid: id } = await sp.ensureLocation({ logicalName: 'x_case', id: CASE }, {}, ADMIN);
  await sp.createFolder(id, { path: [], name: 'Pending' }, ADMIN);
  await sp.createFolder(id, { path: ['Pending'], name: 'Nested' }, ADMIN);
  await sp.upload(id, { path: ['Pending', 'Nested'], name: 'retry.txt', bytes: Buffer.from('fixture') }, ADMIN);
  await assert.rejects(sp.deleteFolder(id, ['Pending'], ADMIN), providerError);
  const remaining = await sp.listDocuments(id, ADMIN, { path: ['Pending', 'Nested'] });
  assert.deepEqual(
    remaining.map((item) => item.name),
    ['retry.txt'],
  );

  blocked = false;
  await sp.deleteFolder(id, ['Pending'], ADMIN);
  assert.deepEqual(await sp.listDocuments(id, ADMIN), []);
});

test('a failed provider folder creation leaves no document location rows', async (t) => {
  const providerError = new Error('Invented provider failure');
  let blocked = true;
  const { sp, store } = await setup(t, {
    wrapStorage: (provider) => ({
      ...provider,
      put(key, body, options) {
        if (blocked && key.endsWith('/_folder')) throw providerError;
        return provider.put(key, body, options);
      },
    }),
  });
  const regarding = { logicalName: 'x_case', id: CASE };
  await assert.rejects(sp.ensureLocation(regarding, {}, ADMIN), providerError);
  assert.equal(store.state.tables.sharepointdocumentlocation.length, 0);

  blocked = false;
  const location = await sp.ensureLocation(regarding, {}, ADMIN);
  assert.equal(store.state.tables.sharepointdocumentlocation.length, 2);
  assert.deepEqual(await sp.listDocuments(location.sharepointdocumentlocationid, ADMIN), []);
});

// @test-kind unproven: two runtimes whose adapters share one backend agree on a file-versus-folder name through a single-key name claim (If-None-Match: *); SharePoint's own answer to a simultaneous file and folder of one name is not captured
test('a file and a folder of one name created at once by two runtimes over one backend: one wins, the other is refused', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'sharepoint-shared-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const local = createLocalDiskStorage({ root });
  ownedFixture(t).add(() => local.close());
  // Both runtimes read "no claim" before either writes one: the race the in-process coordination cannot see.
  let gate = null;
  const shared = {
    ...local,
    async head(key) {
      const answer = await local.head(key);
      if (gate) {
        gate.count += 1;
        if (gate.count === 2) gate.release();
        await gate.both;
      }
      return answer;
    },
  };
  const first = await setup(t, { shared });
  const second = await setup(t, { shared });
  const regarding = { logicalName: 'x_case', id: CASE };
  const a = (await first.sp.ensureLocation(regarding, {}, ADMIN)).sharepointdocumentlocationid;
  const b = (await second.sp.ensureLocation(regarding, {}, ADMIN)).sharepointdocumentlocationid;
  for (const order of [
    ['file', 'folder'],
    ['folder', 'file'],
  ]) {
    const name = `Shared ${order[0]}`;
    const both = Promise.withResolvers();
    gate = { count: 0, both: both.promise, release: both.resolve };
    const create = (kind, sp, id) =>
      kind === 'file'
        ? sp.upload(id, { name, bytes: Buffer.from('fixture') }, ADMIN)
        : sp.createFolder(id, { path: [], name }, ADMIN);
    const results = await Promise.allSettled([create(order[0], first.sp, a), create(order[1], second.sp, b)]);
    gate = null;
    const won = results.filter((result) => result.status === 'fulfilled');
    const lost = results.filter((result) => result.status === 'rejected');
    assert.equal(won.length, 1, JSON.stringify(results));
    assert.equal(lost[0].reason.status, 409);
    assert.ok(['SharePointNameExists', 'SharePointFolderExists'].includes(lost[0].reason.code), lost[0].reason.code);
    // Both runtimes see the one winner.
    for (const [sp, id] of [
      [first.sp, a],
      [second.sp, b],
    ]) {
      const listed = (await sp.listDocuments(id, ADMIN)).filter((item) => item.name === name);
      assert.equal(listed.length, 1, JSON.stringify(listed));
    }
  }
});

// @test-kind contract: a name claim never shows as a document, is released with its file, and a claim nothing stands behind is taken over once it is a minute old
test('name claims stay out of listings, go with their file and expire when nothing stands behind them', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'sharepoint-claims-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  let providerNow = Date.now();
  const local = createLocalDiskStorage({ root, clock: () => providerNow });
  ownedFixture(t).add(() => local.close());
  const { sp } = await setup(t, { shared: local });
  const { sharepointdocumentlocationid: id } = await sp.ensureLocation({ logicalName: 'x_case', id: CASE }, {}, ADMIN);
  await sp.upload(id, { name: 'Claimed.txt', bytes: Buffer.from('fixture') }, ADMIN);
  assert.deepEqual(
    (await sp.listDocuments(id, ADMIN)).map((item) => item.name),
    ['Claimed.txt'],
  );
  await assert.rejects(sp.createFolder(id, { path: [], name: 'claimed.txt' }, ADMIN), { status: 409 });
  await sp.delete(id, 'Claimed.txt', {}, ADMIN);
  await sp.createFolder(id, { path: [], name: 'Claimed.txt' }, ADMIN);
  assert.deepEqual(
    (await sp.listDocuments(id, ADMIN)).map((item) => [item.name, Boolean(item.folder)]),
    [['Claimed.txt', true]],
  );
  await sp.deleteFolder(id, ['Claimed.txt'], ADMIN);
  assert.deepEqual(await sp.listDocuments(id, ADMIN), []);
  const folder = (await local.list('sharepoint/')).items
    .map((item) => item.key)
    .find((key) => key.endsWith('/_folder'));
  const record = folder.slice(0, -'/_folder'.length);
  // A folder claim whose creator stopped before its marker: fresh, it holds the name; a minute later, a file takes it.
  const claim = () => local.put(`${record}/stale.txt/_name`, Buffer.alloc(0), { metadata: { kind: 'folder' } });
  await claim();
  await assert.rejects(sp.upload(id, { name: 'Stale.txt', bytes: Buffer.from('x') }, ADMIN), {
    status: 409,
    code: 'SharePointNameExists',
  });
  providerNow = Date.now() - 61_000;
  await claim();
  providerNow = Date.now();
  await sp.upload(id, { name: 'Stale.txt', bytes: Buffer.from('x') }, ADMIN);
  assert.deepEqual(
    (await sp.listDocuments(id, ADMIN)).map((item) => item.name),
    ['Stale.txt'],
  );
});

test('upload, list and delete carry provider ETags and honour If-Match', async (t) => {
  const { sp } = await setup(t);
  const { sharepointdocumentlocationid: id } = await sp.ensureLocation({ logicalName: 'x_case', id: CASE }, {}, ADMIN);
  const first = await sp.upload(
    id,
    { name: 'Report A_1.txt', bytes: Buffer.from('one'), contentType: 'text/plain' },
    ADMIN,
  );
  assert.match(first.etag, /^".+"$/);
  const second = await sp.upload(
    id,
    { name: 'Report A_1.txt', bytes: Buffer.from('two!'), ifMatch: first.etag },
    ADMIN,
  );
  assert.notEqual(second.etag, first.etag);
  await assert.rejects(sp.upload(id, { name: 'Report A_1.txt', bytes: Buffer.from('x'), ifMatch: first.etag }, ADMIN), {
    status: 412,
  });
  const listed = await sp.listDocuments(id, ADMIN);
  assert.deepEqual(
    listed.map(({ name, size, etag }) => ({ name, size, etag })),
    [{ name: 'Report A_1.txt', size: 4, etag: second.etag }],
  );
  await assert.rejects(sp.delete(id, 'Report A_1.txt', { ifMatch: first.etag }, ADMIN), { status: 412 });
  assert.deepEqual(await sp.delete(id, 'Report A_1.txt', { ifMatch: second.etag }, ADMIN), { deleted: true });
  assert.deepEqual(await sp.listDocuments(id, ADMIN), []);
  await assert.rejects(sp.delete(id, 'Report A_1.txt', {}, ADMIN), { status: 404 });
  await assert.rejects(sp.upload(id, { name: '../escape', bytes: Buffer.from('x') }, ADMIN), {
    code: 'SharePointInvalidName',
  });
});

test('a non-admin caller without privilege on the regarding record is refused', async (t) => {
  const { sp, api, store } = await setup(t);
  const nobody = api.principals.byId(NOBODY);
  assert.ok(nobody);
  await assert.rejects(sp.ensureLocation({ logicalName: 'x_case', id: CASE }, {}, { user: nobody }), { status: 403 });
  assert.equal(store.state.tables.sharepointdocumentlocation.length, 0);
  // A caller holding the privilege (the fixture's System Administrator application user) passes as a user, not as admin.
  const privileged = api.principals.byApplicationId('77777777-7777-4777-8777-777777777777');
  const { sharepointdocumentlocationid: id, ownerid } = await sp.ensureLocation(
    { logicalName: 'x_case', id: CASE },
    {},
    { user: privileged },
  );
  assert.equal(ownerid.id, privileged.systemuserid);
  await assert.rejects(sp.listDocuments(id, { user: nobody }), { status: 403 });
  await assert.rejects(sp.upload(id, { name: 'a.txt', bytes: Buffer.from('a') }, { user: nobody }), { status: 403 });
  await assert.rejects(sp.listDocuments(id), { status: 403 });
});

test('the organization attachment size limit refuses a large upload', async (t) => {
  const { sp, store } = await setup(t);
  const { sharepointdocumentlocationid: id } = await sp.ensureLocation({ logicalName: 'x_case', id: CASE }, {}, ADMIN);
  store.state.simulator = { ...(store.state.simulator ?? {}), platformOverrides: { MaxUploadFileSize: 8 } };
  await assert.rejects(sp.upload(id, { name: 'big.bin', bytes: Buffer.alloc(64) }, ADMIN), {
    code: 'AttachmentTooLarge',
  });
  assert.deepEqual(await sp.listDocuments(id, ADMIN), []);
});

test('without storage every storage operation answers 501 and reports one diagnostic', async (t) => {
  const { sp, diagnostics } = await setup(t, { withStorage: false });
  await assert.rejects(sp.ensureLocation({ logicalName: 'x_case', id: CASE }, {}, ADMIN), {
    status: 501,
    code: 'SharePointStorageNotConfigured',
  });
  await assert.rejects(sp.ensureLocation({ logicalName: 'x_case', id: CASE }, {}, ADMIN), { status: 501 });
  assert.deepEqual(await sp.locationsFor({ logicalName: 'x_case', id: CASE }, ADMIN), []);
  assert.equal(diagnostics.filter((entry) => entry.code === 'SHAREPOINT_ROUTE_MISSING').length, 1);
  assert.equal(sp.describe().level, 'contract');
});

test('describe levels follow storage', async (t) => {
  const { sp } = await setup(t);
  const record = sp.describe();
  assert.equal(record.level, 'behaviour');
  assert.deepEqual(record.requires, ['provider:storage/sharepointDocuments', 'table:sharepointdocumentlocation']);
  const levels = Object.fromEntries(record.operations.map((op) => [op.name, op.level]));
  assert.equal(levels.upload, 'behaviour');
  assert.equal(levels.powerPagesDocumentControl, 'contract');
  assert.equal(levels.autoFolderNaming, 'contract');
  assert.equal(EXTENSION.describe().level, 'contract');
});

// @test-kind contract: a name claim is renewed while its write runs, so a claim of an upload that takes longer than the one-minute staleness is never taken over by another runtime's folder create
test('a long upload keeps its name claim: another runtime cannot take it over and create a folder of that name', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'sharepoint-long-upload-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const clock = fixedClock(Date.parse('2026-03-02T09:00:00.000Z'));
  const local = createLocalDiskStorage({ root, clock: () => clock.now() });
  ownedFixture(t).add(() => local.close());
  // The upload's bytes are held at the provider until the test lets them through.
  let held = null;
  const reached = Promise.withResolvers(),
    release = Promise.withResolvers();
  const shared = {
    ...local,
    async put(key, body, options) {
      if (held === null && key.endsWith('/long.txt')) {
        held = key;
        reached.resolve();
        await release.promise;
      }
      return local.put(key, body, options);
    },
  };
  const first = await setup(t, { shared });
  const second = await setup(t, { shared });
  // Both runtimes read the same runtime clock; the first one's renewals run on its manual scheduler.
  const scheduler = createScheduler({ clock, manual: true });
  ownedFixture(t).add(() => scheduler.close());
  for (const { api } of [first, second]) api.store.clock = clock;
  first.api.store.scheduler = scheduler;
  const regarding = { logicalName: 'x_case', id: CASE };
  const a = (await first.sp.ensureLocation(regarding, {}, ADMIN)).sharepointdocumentlocationid;
  const b = (await second.sp.ensureLocation(regarding, {}, ADMIN)).sharepointdocumentlocationid;
  const upload = first.sp.upload(a, { name: 'Long.txt', bytes: Buffer.from('long upload') }, ADMIN);
  await reached.promise;
  for (const step of [20_000, 20_000, 21_000]) await scheduler.advance(step);
  await assert.rejects(second.sp.createFolder(b, { path: [], name: 'long.txt' }, ADMIN), {
    status: 409,
    code: 'SharePointNameExists',
  });
  release.resolve();
  assert.equal((await upload).name, 'Long.txt');
  assert.deepEqual(
    (await second.sp.listDocuments(b, ADMIN)).map((item) => [item.name, Boolean(item.folder)]),
    [['Long.txt', false]],
  );
  // The renewals stop with the upload.
  assert.equal(scheduler.status().scheduled, 0);
});
