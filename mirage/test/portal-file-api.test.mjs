// @test-kind compatibility: Power Pages Azure Blob Storage file Web API routes, site settings, FU000xx statuses, codes and messages, https://learn.microsoft.com/power-pages/configure/webapi-azure-blob
// The file API (lib/portal-file-api.mjs) over an invented site, invented x_case table and an in-memory provider on storage
// route portalCloudAttachments. Tests that encode Mirage's own design or an inferred rule carry their own kind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulatorFixture } from './fixtures/source-site.mjs';
import { signInHeaders } from '../testing.mjs';
import { fixedClock } from '../lib/runtime-clock.mjs';
import { handlePortalFileApi } from '../lib/portal-file-api.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const guid = (n) => `4f000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SITE = guid(1);
const UPLOADER = guid(2);
const READER = guid(3);
const OWNER = guid(10);
const OTHER = guid(11);
const LIMITED = guid(12);
const CASE = guid(20);
const OTHER_CASE = guid(21);
const PLAIN_NOTE = guid(30);
const MB = 1024 * 1024;

const SETTINGS = {
  'Site/FileManagement/EnableWebAPI': 'true',
  'Site/FileManagement/BlobStorageAccountName': 'inventedaccount',
  'Site/FileManagement/BlobStorageContainerName': 'invented-files',
  'Site/FileManagement/SupportedFileType': '.txt,.pdf',
  'Site/FileManagement/SupportedMimeType': 'text/plain;application/pdf',
  'Site/FileManagement/MaxFileSize': '2048',
};
// The walk-through's grants (record: Read, Append to; note: Read, Write, Create, Append), plus Delete for delete. Cases are
// scoped to their contact and notes to their case, so another contact's case and its notes are out of reach.
const casePermission = (operations, roles = ['Uploader']) => ({
  id: 'cases',
  entity: 'x_case',
  scope: 'contact',
  field: 'x_contact',
  roles,
  operations,
});
const notePermission = (operations, roles = ['Uploader']) => ({
  id: 'notes',
  entity: 'annotation',
  scope: 'parent',
  parentPermissionId: 'cases',
  relationship: { entity: 'x_case', from: 'objectid', to: 'x_caseid' },
  roles,
  operations,
});
const PERMISSIONS = [
  casePermission(['read', 'appendTo']),
  notePermission(['read', 'update', 'create', 'append', 'delete']),
];

async function fileApiFixture(
  t,
  { settings = SETTINGS, permissions = PERMISSIONS, route = true, clock, stateDir = null } = {},
) {
  // With stateDir the cloud provider is local disk under <stateDir>/cloud; without it, in memory.
  const cloud = stateDir ? { kind: 'local-disk', root: 'cloud' } : { kind: 'local-disk' };
  const sim = await simulatorFixture(t, {
    prefix: 'portal-file-api-',
    files: {
      'website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented Files`,
      'webrole.yml': `- adx_webroleid: ${UPLOADER}\n  adx_name: Uploader\n- adx_webroleid: ${READER}\n  adx_name: Reader`,
      'web-pages/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
      'sitesetting.yml':
        Object.entries(settings)
          .map(
            ([name, value], index) =>
              `- adx_sitesettingid: ${guid(100 + index)}\n  adx_name: ${name}\n  adx_value: ${JSON.stringify(value)}`,
          )
          .join('\n') || '[]',
    },
    port: 0,
    watch: false,
    ...(clock ? { clock } : {}),
    ...(stateDir ? { stateFile: path.join(stateDir, 'state.json') } : {}),
    ...(route ? { providers: { storage: { cloud }, routes: { portalCloudAttachments: 'cloud' } } } : {}),
    initial: {
      version: 1,
      mappings: {
        contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
        annotation: { entitySet: 'annotations', idColumn: 'annotationid' },
        x_case: { entitySet: 'x_cases', idColumn: 'x_caseid', nameColumn: 'x_name' },
      },
      permissions,
      tables: {
        contact: [
          { contactid: OWNER, fullname: 'Invented Owner', statecode: 0 },
          { contactid: OTHER, fullname: 'Invented Other', statecode: 0 },
          { contactid: LIMITED, fullname: 'Invented Limited', statecode: 0 },
        ],
        x_case: [
          { x_caseid: CASE, x_name: 'Invented case', x_contact: { id: OWNER, logical_name: 'contact' } },
          { x_caseid: OTHER_CASE, x_name: 'Other case', x_contact: { id: OTHER, logical_name: 'contact' } },
        ],
        annotation: [
          {
            annotationid: PLAIN_NOTE,
            subject: 'Invented plain note',
            filename: 'plain.txt',
            mimetype: 'text/plain',
            documentbody: Buffer.from('plain').toString('base64'),
            objectid: { id: CASE, logical_name: 'x_case' },
          },
        ],
      },
      settings: { permissionMode: 'enforce' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        permissionSource: 'configured',
        contactRoles: [
          { contactId: OWNER, roleId: UPLOADER },
          { contactId: OTHER, roleId: UPLOADER },
          { contactId: LIMITED, roleId: READER },
        ],
      },
    },
  });
  return sim;
}

// A browser session: the contact's sign-in cookie, the page's verification token and the visitor cookie the first
// InitializeUpload starts.
function browser(sim, contact) {
  const headers = { ...(contact ? signInHeaders(sim, contact) : {}), __requestverificationtoken: sim.csrf };
  const send = async (method, path, { body, extra = {}, redirect } = {}) => {
    const response = await fetch(sim.url + path, { method, headers: { ...headers, ...extra }, body, redirect });
    const visitor = response.headers.get('set-cookie')?.split(';')[0];
    if (visitor) headers.cookie = [headers.cookie, visitor].filter(Boolean).join('; ');
    return response;
  };
  return {
    headers,
    initialize: ({ table = 'x_case', id = CASE, name = 'report.txt', size = 10, extra } = {}) =>
      send('POST', `/_api/file/InitializeUpload/${table}(${id})/blob`, {
        body: '{}',
        extra: {
          'content-type': 'application/octet-stream',
          ...(name == null ? {} : { 'x-ms-file-name': name }),
          ...(size == null ? {} : { 'x-ms-file-size': String(size) }),
          ...extra,
        },
      }),
    block: (token, offset, bytes, { fileSize = 10, chunkSize = 6, name = 'report.txt' } = {}) => {
      const query = new URLSearchParams({ offset: String(offset), token });
      if (fileSize != null) query.set('fileSize', String(fileSize));
      if (chunkSize != null) query.set('chunkSize', String(chunkSize));
      return send('PUT', `/_api/file/UploadBlock/blob?${query}`, {
        body: bytes,
        extra: { 'content-type': 'application/octet-stream', ...(name == null ? {} : { 'x-ms-file-name': name }) },
      });
    },
    // The download answers a redirect to its read URL (DownloadViaSASUri, default true); the browser follows it with the
    // visitor cookie the redirect may set, as a page's link does.
    download: async (id, table = 'annotation', { follow = true, extra } = {}) => {
      const first = await send('GET', `/_api/file/download/${table}(${id})/blob/$value`, { redirect: 'manual' });
      return follow && first.status === 302 ? send('GET', first.headers.get('location'), { extra }) : first;
    },
    remove: (id, table = 'annotation') => send('DELETE', `/_api/file/delete/${table}(${id})/blob/$value`),
    send,
  };
}

// Learn "Error codes and messages" (status, message); {0} messages are checked where a test fills them in.
const DOCUMENTED = {
  FU00001: [400, "File content isn't specified"],
  FU00002: [404, "Record isn't found"],
  FU00003: [403, "You don't have permissions to perform this operation"],
  FU00004: [400, "File extension isn't supported."],
  FU00005: [400, "File mimetype isn't supported"],
  FU00006: [400, null],
  FU00007: [400, 'Azure configurations are incorrect'],
  FU00008: [400, 'Header x-ms-file-name is missing in the request'],
  FU00009: [501, "Azure webapi isn't enabled for use"],
  FU00010: [400, null],
  FU00012: [400, "File doesn't exist"],
  FU00013: [400, 'Chunk size is greater than 100mb'],
  FU00014: [400, 'File size not provided'],
  FU00015: [400, 'File extension is not supported'],
  FU00016: [400, 'File mimetype is not supported'],
  FU00017: [400, 'File size is more than 128mb'],
  FU00022: [400, 'Azure configurations are incorrect'],
};

// A documented code answers its status and message; a Mirage-own code also names itself in X-Sim-Error-Code.
async function expectError(response, code) {
  const body = await response.json();
  assert.equal(body.error?.code, code, JSON.stringify(body));
  const documented = DOCUMENTED[code];
  if (documented) {
    assert.equal(response.status, documented[0]);
    if (documented[1] !== null) assert.equal(body.error.message, documented[1]);
  } else assert.equal(response.headers.get('x-sim-error-code'), code);
  return body;
}

async function started(client, options) {
  const response = await client.initialize(options);
  assert.equal(response.status, 200, await response.clone().text());
  const token = await response.json();
  assert.match(token, /^[0-9a-f-]{36}$/);
  return token;
}

const note = (sim, id) => sim.store.tableRows('annotation').find((row) => row.annotationid === id);

test('a file uploads in chunks, downloads byte for byte and deletes with its note', async (t) => {
  const sim = await fileApiFixture(t);
  const owner = browser(sim, OWNER);
  const token = await started(owner);
  // The token is the note: it exists from InitializeUpload, linked to the record and named <file>.azure.txt.
  const created = note(sim, token);
  assert.equal(created.filename, 'report.txt.azure.txt');
  assert.equal(created.objectid.id ?? created.objectid, CASE);
  const versions = [Number(created.versionnumber)];
  // Until the last chunk the file is not in storage. Each chunk updates the note (Learn: "multiple updates on the note").
  assert.equal((await owner.block(token, 0, '012345')).status, 204);
  versions.push(Number(note(sim, token).versionnumber));
  await expectError(await owner.download(token), 'FU00012');
  const last = await owner.block(token, 6, '6789');
  assert.equal(last.status, 204, await last.text());
  versions.push(Number(note(sim, token).versionnumber));
  assert.ok(versions[0] < versions[1] && versions[1] < versions[2], JSON.stringify(versions));
  const downloaded = await owner.download(token);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('content-type'), 'text/plain');
  assert.match(downloaded.headers.get('content-disposition'), /^attachment; filename="report\.txt"/);
  assert.equal(await downloaded.text(), '0123456789');
  // The completed upload no longer takes chunks.
  await expectError(await owner.block(token, 0, '012345'), 'FU00010');
  const removed = await owner.remove(token);
  assert.equal(removed.status, 204, await removed.text());
  assert.equal(note(sim, token), undefined);
  await expectError(await owner.download(token), 'FU00002');
});

// @test-kind unproven: chunks placed by their offset in any order and committed once all arrived models Azure Put Block plus Put Block List; Learn shows only sequential chunks
test('chunks may arrive out of order; the file is complete once every chunk is staged', async (t) => {
  const sim = await fileApiFixture(t);
  const owner = browser(sim, OWNER);
  const token = await started(owner, { size: 14 });
  for (const [offset, part] of [
    [12, 'cd'],
    [0, '012345'],
    [6, '6789ab'],
  ]) {
    const response = await owner.block(token, offset, part, { fileSize: 14 });
    assert.equal(response.status, 204, await response.text());
  }
  assert.equal(await (await owner.download(token)).text(), '0123456789abcd');
});

// @test-kind contract: Mirage-own refusals for chunk geometry; Learn documents no code for an overlapping or mis-sized chunk
test('an overlapping, resized or mis-sized chunk is refused and the upload continues', async (t) => {
  const sim = await fileApiFixture(t);
  const owner = browser(sim, OWNER);
  const token = await started(owner);
  assert.equal((await owner.block(token, 0, '012345')).status, 204);
  const overlap = await owner.block(token, 3, '345678');
  assert.equal(overlap.headers.get('x-sim-error-code'), 'FileBlockOffsetInvalid');
  await expectError(overlap, 'FileBlockOffsetInvalid');
  await expectError(await owner.block(token, 5, '56789', { chunkSize: 5 }), 'FileBlockSizeInconsistent');
  await expectError(await owner.block(token, 6, '678'), 'FileBlockLengthInvalid');
  await expectError(await owner.block(token, 6, '6789x'), 'FileBlockLengthInvalid');
  await expectError(await owner.block(token, 12, 'zz'), 'FileBlockOffsetInvalid');
  assert.equal((await owner.block(token, 6, '6789')).status, 204);
  assert.equal(await (await owner.download(token)).text(), '0123456789');
});

test('the API answers FU00009 on every route while Site/FileManagement/EnableWebAPI is not true', async (t) => {
  const { 'Site/FileManagement/EnableWebAPI': _enabled, ...rest } = SETTINGS; // NOSONAR: binding is excluded from the rest object
  const sim = await fileApiFixture(t, { settings: rest });
  const owner = browser(sim, OWNER);
  await expectError(await owner.initialize(), 'FU00009');
  await expectError(await owner.block(guid(40), 0, '012345'), 'FU00009');
  await expectError(await owner.download(PLAIN_NOTE), 'FU00009');
  await expectError(await owner.remove(PLAIN_NOTE), 'FU00009');
  assert.ok(note(sim, PLAIN_NOTE));
  assert.equal(sim.store.tableRows('annotation').length, 1);
});

test('InitializeUpload answers the documented validation errors and creates no note', async (t) => {
  const sim = await fileApiFixture(t);
  const owner = browser(sim, OWNER);
  await expectError(await owner.initialize({ name: null }), 'FU00008');
  await expectError(await owner.initialize({ size: null }), 'FU00014');
  await expectError(await owner.initialize({ size: 0 }), 'FU00001');
  await expectError(await owner.initialize({ name: 'tool.exe' }), 'FU00004');
  await expectError(await owner.initialize({ name: 'noextension' }), 'FU00004');
  const tooLarge = await expectError(await owner.initialize({ size: 2 * MB + 1 }), 'FU00006');
  assert.equal(tooLarge.error.message, 'File size is greater than 2MB');
  await expectError(await owner.initialize({ table: 'x_unknown' }), 'FU00002');
  await expectError(await owner.initialize({ id: guid(99) }), 'FU00002');
  await expectError(await owner.initialize({ id: 'not-a-guid' }), 'FU00002');
  assert.equal(sim.store.tableRows('annotation').length, 1);
});

test('the supported type and MIME type settings are mandatory and checked separately', async (t) => {
  await t.test('FU00015 without SupportedFileType', async (sub) => {
    const { 'Site/FileManagement/SupportedFileType': _types, ...settings } = SETTINGS; // NOSONAR: binding is excluded from the rest object
    const sim = await fileApiFixture(sub, { settings });
    await expectError(await browser(sim, OWNER).initialize(), 'FU00015');
  });
  await t.test('FU00016 without SupportedMimeType', async (sub) => {
    const { 'Site/FileManagement/SupportedMimeType': _mimes, ...settings } = SETTINGS; // NOSONAR: binding is excluded from the rest object
    const sim = await fileApiFixture(sub, { settings });
    await expectError(await browser(sim, OWNER).initialize(), 'FU00016');
  });
  await t.test('FU00005 for a listed extension whose MIME type is not listed', async (sub) => {
    const sim = await fileApiFixture(sub, {
      settings: { ...SETTINGS, 'Site/FileManagement/SupportedMimeType': 'text/plain' },
    });
    await expectError(await browser(sim, OWNER).initialize({ name: 'report.pdf' }), 'FU00005');
  });
});

test('the Azure storage settings and the storage route are required', async (t) => {
  await t.test('FU00022 without an account or container name', async (sub) => {
    const { 'Site/FileManagement/BlobStorageAccountName': _account, ...settings } = SETTINGS; // NOSONAR: binding is excluded from the rest object
    const sim = await fileApiFixture(sub, { settings });
    await expectError(await browser(sim, OWNER).initialize(), 'FU00022');
  });
  // @test-kind unproven: an invalid container name or a missing provider route stands for Azure's incorrect configuration; Learn does not say which configuration answers FU00007
  await t.test('FU00007 for an invalid container name or no portalCloudAttachments provider', async (sub) => {
    const invalid = await fileApiFixture(sub, {
      settings: { ...SETTINGS, 'Site/FileManagement/BlobStorageContainerName': 'Invalid_Container' },
    });
    await expectError(await browser(invalid, OWNER).initialize(), 'FU00007');
    const unrouted = await fileApiFixture(sub, { route: false });
    await expectError(await browser(unrouted, OWNER).initialize(), 'FU00007');
    assert.equal(unrouted.store.tableRows('annotation').length, 1);
  });
});

test('UploadBlock answers the documented chunk errors', async (t) => {
  const sim = await fileApiFixture(t, { settings: { ...SETTINGS, 'Site/FileManagement/MaxFileSize': '1048576' } });
  const owner = browser(sim, OWNER);
  const token = await started(owner);
  await expectError(await owner.block(token, 0, '012345', { name: null }), 'FU00008');
  await expectError(await owner.block(token, 0, '012345', { fileSize: null }), 'FU00014');
  await expectError(await owner.block(token, 0, '', {}), 'FU00001');
  await expectError(await owner.block(token, 0, '012345', { chunkSize: 100 * MB + 1 }), 'FU00013');
  const unknown = await expectError(await owner.block(guid(41), 0, '012345'), 'FU00010');
  assert.equal(unknown.error.message, "Requested file isn't available for uploadblock");
  // Without chunkSize a request carries the whole file, which may not exceed 128 MB.
  const large = await started(owner, { size: 129 * MB });
  await expectError(await owner.block(large, 0, '0', { fileSize: 129 * MB, chunkSize: null }), 'FU00017');
  const whole = await started(owner, { name: 'whole.txt' });
  const single = await owner.block(whole, 0, 'abcdefghij', { chunkSize: null, name: 'whole.txt' });
  assert.equal(single.status, 204, await single.text());
  assert.equal(await (await owner.download(whole)).text(), 'abcdefghij');
});

test('download and delete answer FU00002, FU00010 and FU00012 for unusable notes', async (t) => {
  const sim = await fileApiFixture(t);
  const owner = browser(sim, OWNER);
  await expectError(await owner.download(guid(42)), 'FU00002');
  await expectError(await owner.remove('not-a-guid'), 'FU00002');
  const plain = await expectError(await owner.download(PLAIN_NOTE), 'FU00010');
  assert.equal(plain.error.message, "Requested file isn't available for download");
  const plainDelete = await expectError(await owner.remove(PLAIN_NOTE), 'FU00010');
  assert.equal(plainDelete.error.message, "Requested file isn't available for delete");
  await expectError(await owner.download(CASE, 'x_case'), 'FU00010');
  assert.ok(note(sim, PLAIN_NOTE));
  const pending = await started(owner);
  await expectError(await owner.download(pending), 'FU00012');
});

// @test-kind security: the file routes enforce the portal Web API's verification token on writes
test('writes without this session verification token answer the portal Web API token errors', async (t) => {
  const sim = await fileApiFixture(t);
  const owner = browser(sim, OWNER);
  const { __requestverificationtoken: _token, ...withoutToken } = owner.headers; // NOSONAR: binding is excluded from the rest object
  const missing = await fetch(`${sim.url}/_api/file/InitializeUpload/x_case(${CASE})/blob`, {
    method: 'POST',
    headers: { ...withoutToken, 'x-ms-file-name': 'report.txt', 'x-ms-file-size': '10' },
  });
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.code, '90040107');
  const wrong = await owner.initialize({ extra: { __requestverificationtoken: 'not-this-session' } });
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).error.code, '90040107');
  const token = await started(owner);
  const blockWithout = await fetch(
    `${sim.url}/_api/file/UploadBlock/blob?offset=0&fileSize=10&chunkSize=10&token=${token}`,
    {
      method: 'PUT',
      headers: { ...withoutToken, cookie: owner.headers.cookie, 'x-ms-file-name': 'report.txt' },
      body: '0123456789',
    },
  );
  assert.equal(blockWithout.status, 401);
  const deleteWithout = await fetch(`${sim.url}/_api/file/delete/annotation(${token})/blob/$value`, {
    method: 'DELETE',
    headers: { ...withoutToken, cookie: owner.headers.cookie },
  });
  assert.equal(deleteWithout.status, 401);
  assert.ok(note(sim, token));
  assert.equal(sim.store.tableRows('annotation').length, 2);
});

// @test-kind security: table permissions on the record and the note gate every file route (FU00003), as the portal Web API's
test('table permissions on the record and the note gate the file routes', async (t) => {
  await t.test('no Append to on the record', async (sub) => {
    const sim = await fileApiFixture(sub, {
      permissions: [casePermission(['read']), notePermission(['read', 'update', 'create', 'append', 'delete'])],
    });
    await expectError(await browser(sim, OWNER).initialize(), 'FU00003');
    assert.equal(sim.store.tableRows('annotation').length, 1);
  });
  await t.test('no Create on the note', async (sub) => {
    const sim = await fileApiFixture(sub, {
      permissions: [casePermission(['read', 'appendTo']), notePermission(['read', 'update', 'append', 'delete'])],
    });
    await expectError(await browser(sim, OWNER).initialize(), 'FU00003');
    assert.equal(sim.store.tableRows('annotation').length, 1);
  });
  await t.test('no Append on the note', async (sub) => {
    const sim = await fileApiFixture(sub, {
      permissions: [casePermission(['read', 'appendTo']), notePermission(['read', 'update', 'create', 'delete'])],
    });
    await expectError(await browser(sim, OWNER).initialize(), 'FU00003');
  });
  await t.test('another contact record', async (sub) => {
    const sim = await fileApiFixture(sub);
    await expectError(await browser(sim, OWNER).initialize({ id: OTHER_CASE }), 'FU00003');
    await expectError(await browser(sim, LIMITED).initialize(), 'FU00003');
    await expectError(await browser(sim, null).initialize(), 'FU00003');
    assert.equal(sim.store.tableRows('annotation').length, 1);
  });
  await t.test('a note of another contact record cannot be downloaded or deleted', async (sub) => {
    const sim = await fileApiFixture(sub);
    const other = browser(sim, OTHER);
    const token = await started(other, { id: OTHER_CASE });
    assert.equal((await other.block(token, 0, '0123456789', { chunkSize: 10 })).status, 204);
    const owner = browser(sim, OWNER);
    await expectError(await owner.download(token), 'FU00003');
    await expectError(await owner.remove(token), 'FU00003');
    await expectError(await browser(sim, null).download(token), 'FU00003');
    assert.ok(note(sim, token));
    assert.equal(await (await other.download(token)).text(), '0123456789');
  });
  await t.test('no Delete on the note', async (sub) => {
    const sim = await fileApiFixture(sub, {
      permissions: [casePermission(['read', 'appendTo']), notePermission(['read', 'update', 'create', 'append'])],
    });
    const owner = browser(sim, OWNER);
    const token = await started(owner);
    assert.equal((await owner.block(token, 0, '0123456789', { chunkSize: 10 })).status, 204);
    await expectError(await owner.remove(token), 'FU00003');
    assert.ok(note(sim, token));
    assert.equal(await (await owner.download(token)).text(), '0123456789');
  });
});

// @test-kind security: an upload token is bound to the visitor session, identity and file that started it
test('another visitor, identity or file cannot use an upload token', async (t) => {
  const sim = await fileApiFixture(t);
  const owner = browser(sim, OWNER);
  const token = await started(owner);
  assert.equal((await owner.block(token, 0, '012345')).status, 204);
  // Another signed-in contact with the same grants and the owner's contact in a second browser session, each holding a
  // visitor session of its own (from an upload it started), and an anonymous visitor without one.
  const other = browser(sim, OTHER);
  await started(other, { id: OTHER_CASE });
  const secondSession = browser(sim, OWNER);
  await started(secondSession);
  for (const stranger of [other, secondSession, browser(sim, null)])
    await expectError(await stranger.block(token, 6, 'XXXX'), 'FU00010');
  await expectError(await owner.block(token, 6, '6789', { name: 'renamed.txt' }), 'FU00010');
  await expectError(await owner.block(token, 6, '6789', { fileSize: 11 }), 'FU00010');
  assert.equal((await owner.block(token, 6, '6789')).status, 204);
  assert.equal(await (await owner.download(token)).text(), '0123456789');
});

// @test-kind security: a note's placeholder can only address the file stored under that note's own id
test('a placeholder that names another note file is not downloaded', async (t) => {
  const sim = await fileApiFixture(t);
  const owner = browser(sim, OWNER);
  const token = await started(owner);
  assert.equal((await owner.block(token, 0, '0123456789', { chunkSize: 10 })).status, 204);
  const forged = guid(50);
  const placeholder = { Name: 'report.txt', Type: 'text/plain', Size: 10, Url: `invented-files/${token}/report.txt` };
  await sim.store.transact(() =>
    sim.store.state.tables.annotation.push({
      annotationid: forged,
      filename: 'copy.txt.azure.txt',
      mimetype: 'text/plain',
      documentbody: Buffer.from(JSON.stringify(placeholder)).toString('base64'),
      objectid: { id: CASE, logical_name: 'x_case' },
    }),
  );
  await expectError(await owner.download(forged), 'FU00010');
  await expectError(await owner.remove(forged), 'FU00010');
  assert.equal(await (await owner.download(token)).text(), '0123456789');
});

// A complete ten-byte upload of report.txt by `client`; answers its token.
async function uploaded(client, bytes = '0123456789') {
  const token = await started(client, { size: bytes.length });
  const done = await client.block(token, 0, bytes, { chunkSize: bytes.length, fileSize: bytes.length });
  assert.equal(done.status, 204, await done.text());
  return token;
}

// The read URL a download redirects to, and its query.
async function readUrlOf(client, token) {
  const response = await client.download(token, 'annotation', { follow: false });
  assert.equal(response.status, 302, await response.clone().text());
  const location = response.headers.get('location');
  return { response, location, query: new URL(location, 'http://invented.localhost').searchParams };
}

// Azure's XML error body and x-ms-error-code.
async function expectBlobError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('x-ms-error-code'), code);
  assert.equal(response.headers.get('content-type'), 'application/xml');
  assert.match(
    await response.text(),
    new RegExp(`^<\\?xml version="1\\.0" encoding="utf-8"\\?><Error><Code>${code}</Code>`),
  );
}

// @test-kind compatibility: Site/FileManagement/DownloadViaSASUri is "True (enabled by default)" and DownloadSASUriExpiryTimeSpan defaults to 00:10:00 (https://learn.microsoft.com/power-pages/configure/webapi-azure-blob); the SAS query names se, sp, sr, rscd, rsct and sig follow https://learn.microsoft.com/rest/api/storageservices/create-service-sas
test('download redirects to a ten-minute read URL that answers the file with its name and type', async (t) => {
  const clock = fixedClock(Date.parse('2026-11-26T10:00:00.250Z'));
  const sim = await fileApiFixture(t, { clock });
  const owner = browser(sim, OWNER);
  const token = await uploaded(owner);
  const { response, location, query } = await readUrlOf(owner, token);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(
    new URL(location, 'http://invented.localhost').pathname,
    `/_api/file/sas/invented-files/${token}/report.txt`,
  );
  assert.equal(query.get('se'), '2026-11-26T10:10:01Z', 'ten minutes, rounded up to the second');
  assert.equal(query.get('sp'), 'r');
  assert.equal(query.get('sr'), 'b');
  assert.equal(query.get('rsct'), 'text/plain');
  assert.match(query.get('rscd'), /^attachment; filename="report\.txt"/);
  const read = await owner.send('GET', location);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('content-type'), 'text/plain');
  assert.match(read.headers.get('content-disposition'), /^attachment; filename="report\.txt"/);
  assert.equal(read.headers.get('accept-ranges'), 'bytes');
  assert.equal(read.headers.get('x-ms-blob-type'), 'BlockBlob');
  assert.ok(read.headers.get('etag'));
  assert.equal(read.headers.get('content-length'), '10');
  assert.equal(await read.text(), '0123456789');
  // A file still uploading has no read URL: the portal's FU00012, as without SAS.
  const pending = await started(owner);
  await expectError(await owner.download(pending, 'annotation', { follow: false }), 'FU00012');
});

// @test-kind compatibility+security: Azure Get Blob Properties answers HEAD on a blob URL with Get Blob's headers and no body (https://learn.microsoft.com/rest/api/storageservices/get-blob-properties); the read URL keeps its signature, expiry and browser binding on HEAD, and an error is the same status and x-ms-error-code without a body
test('the read URL answers HEAD with the blob headers and no body, under the same checks', async (t) => {
  const clock = fixedClock(Date.parse('2026-11-26T10:00:00Z'));
  const sim = await fileApiFixture(t, { clock });
  const owner = browser(sim, OWNER);
  const token = await uploaded(owner);
  const { location, query } = await readUrlOf(owner, token);
  const got = await owner.send('GET', location);
  const head = await owner.send('HEAD', location, { extra: { range: 'bytes=0-3' } });
  assert.equal(head.status, 200, 'HEAD answers the whole blob, never a range');
  assert.equal(await head.text(), '');
  for (const name of [
    'content-type',
    'content-disposition',
    'content-length',
    'etag',
    'accept-ranges',
    'x-ms-blob-type',
  ])
    assert.equal(head.headers.get(name), got.headers.get(name), name);
  assert.equal(head.headers.get('content-length'), '10');
  const expectHeadError = (response, status, code) => {
    assert.equal(response.status, status);
    assert.equal(response.headers.get('x-ms-error-code'), code);
  };
  const path = new URL(location, 'http://invented.localhost').pathname;
  const tampered = new URLSearchParams(query);
  tampered.set('rsct', 'text/html');
  const refused = await owner.send('HEAD', `${path}?${tampered}`);
  expectHeadError(refused, 403, 'AuthenticationFailed');
  assert.equal(await refused.text(), '');
  expectHeadError(await browser(sim, OWNER).send('HEAD', location), 403, 'AuthenticationFailed');
  assert.equal((await owner.remove(token)).status, 204);
  expectHeadError(await owner.send('HEAD', location), 404, 'BlobNotFound');
  clock.advance(10 * 60_000 + 1000);
  expectHeadError(await owner.send('HEAD', location), 403, 'AuthenticationFailed');
});

// @test-kind compatibility: Azure Get Blob answers a byte range with 206, Content-Range and Accept-Ranges, and an unsatisfiable one with 416 InvalidRange (https://learn.microsoft.com/rest/api/storageservices/get-blob, https://learn.microsoft.com/rest/api/storageservices/specifying-the-range-header-for-blob-service-operations, https://learn.microsoft.com/rest/api/storageservices/common-rest-api-error-codes)
test('the read URL answers byte ranges, so a download can resume', async (t) => {
  const sim = await fileApiFixture(t);
  const owner = browser(sim, OWNER);
  const token = await uploaded(owner);
  const { location } = await readUrlOf(owner, token);
  const head = await owner.send('GET', location, { extra: { range: 'bytes=0-3' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-range'), 'bytes 0-3/10');
  assert.equal(head.headers.get('content-length'), '4');
  assert.equal(await head.text(), '0123');
  // The rest, from where the first part ended, with the Azure x-ms-range header.
  const rest = await owner.send('GET', location, { extra: { 'x-ms-range': 'bytes=4-' } });
  assert.equal(rest.status, 206);
  assert.equal(rest.headers.get('content-range'), 'bytes 4-9/10');
  assert.equal(await rest.text(), '456789');
  assert.equal(rest.headers.get('etag'), head.headers.get('etag'), 'both parts come from the same blob version');
  const beyond = await owner.send('GET', location, { extra: { range: 'bytes=10-20' } });
  assert.equal(beyond.headers.get('content-range'), 'bytes */10');
  await expectBlobError(beyond, 416, 'InvalidRange');
  // A range form Get Blob does not take is ignored: the whole blob answers.
  const suffix = await owner.send('GET', location, { extra: { range: 'bytes=-3' } });
  assert.equal(suffix.status, 200);
  assert.equal(await suffix.text(), '0123456789');
});

// @test-kind security: the read URL is signed over its blob path and fields and bound to the visitor session and identity that asked for it; a changed field, another browser, an expired URL or a deleted file is refused without the bytes
test('a read URL refuses tampering, another browser, expiry and a deleted file', async (t) => {
  const clock = fixedClock(Date.parse('2026-11-26T10:00:00Z'));
  const sim = await fileApiFixture(t, { clock });
  const owner = browser(sim, OWNER);
  const token = await uploaded(owner);
  const { location, query } = await readUrlOf(owner, token);
  const path = new URL(location, 'http://invented.localhost').pathname;
  const changed = (name, value) => {
    const copy = new URLSearchParams(query);
    copy.set(name, value);
    return `${path}?${copy}`;
  };
  for (const [name, value] of [
    ['sig', `${query.get('sig').slice(0, -2)}AA`],
    ['se', '2099-01-01T00:00:00Z'],
    ['rsct', 'text/html'],
    ['rscd', 'inline'],
    ['sp', 'rw'],
  ])
    await expectBlobError(await owner.send('GET', changed(name, value)), 403, 'AuthenticationFailed');
  await expectBlobError(await owner.send('GET', path), 403, 'AuthenticationFailed');
  // The signature names the blob: another note's path with this query is refused.
  const second = await uploaded(owner, 'abcdefghij');
  await expectBlobError(
    await owner.send('GET', `${path.replace(token, second)}?${query}`),
    403,
    'AuthenticationFailed',
  );
  // Another contact with the same grants, the owner in a second browser session and an anonymous visitor.
  const other = browser(sim, OTHER);
  await started(other, { id: OTHER_CASE });
  const secondSession = browser(sim, OWNER);
  await started(secondSession);
  for (const stranger of [other, secondSession, browser(sim, null)])
    await expectBlobError(await stranger.send('GET', location), 403, 'AuthenticationFailed');
  assert.equal(await (await owner.send('GET', location)).text(), '0123456789');
  // Ten minutes later the URL has expired; a new download issues a new one.
  clock.advance(10 * 60_000 + 1000);
  await expectBlobError(await owner.send('GET', location), 403, 'AuthenticationFailed');
  const fresh = await readUrlOf(owner, token);
  assert.notEqual(fresh.location, location);
  assert.equal(await (await owner.send('GET', fresh.location)).text(), '0123456789');
  // Deleting the note deletes the blob: its unexpired read URL answers BlobNotFound.
  assert.equal((await owner.remove(token)).status, 204);
  await expectBlobError(await owner.send('GET', fresh.location), 404, 'BlobNotFound');
});

// @test-kind security: a download from a browser without a visitor session starts one and binds the read URL to it
test('a browser without a visitor session gets one with the redirect, and the URL is bound to it', async (t) => {
  const sim = await fileApiFixture(t);
  const token = await uploaded(browser(sim, OWNER));
  // The same contact in a browser that never started an upload: no visitor session yet.
  const fresh = browser(sim, OWNER);
  const { response, location } = await readUrlOf(fresh, token);
  assert.ok(response.headers.get('set-cookie')?.split(';')[0], 'the redirect starts a visitor session');
  assert.equal(await (await fresh.send('GET', location)).text(), '0123456789');
  await expectBlobError(await browser(sim, OWNER).send('GET', location), 403, 'AuthenticationFailed');
});

// @test-kind compatibility: DownloadSASUriExpiryTimeSpan is a .NET TimeSpan (https://learn.microsoft.com/power-pages/configure/webapi-azure-blob, https://learn.microsoft.com/dotnet/standard/base-types/standard-timespan-format-strings)
test('DownloadSASUriExpiryTimeSpan sets the read URL lifetime', async (t) => {
  for (const [value, expiry] of [
    ['00:00:30', '2026-11-26T10:00:30Z'],
    ['1.02:00:00', '2026-11-27T12:00:00Z'],
    ['2', '2026-11-28T10:00:00Z'],
    // Mirage-own: a value that is not a positive span keeps the 00:10:00 default, a longer one than 7 days is held at 7.
    ['soon', '2026-11-26T10:10:00Z'],
    ['00:00:00', '2026-11-26T10:10:00Z'],
    ['30', '2026-12-03T10:00:00Z'],
  ]) {
    const clock = fixedClock(Date.parse('2026-11-26T10:00:00Z'));
    const sim = await fileApiFixture(t, {
      clock,
      settings: { ...SETTINGS, 'Site/FileManagement/DownloadSASUriExpiryTimeSpan': value },
    });
    const owner = browser(sim, OWNER);
    const { query } = await readUrlOf(owner, await uploaded(owner));
    assert.equal(query.get('se'), expiry, value);
  }
});

// @test-kind compatibility: with Site/FileManagement/DownloadViaSASUri false the portal answers the file and DownloadChunkSizeInKB decides the read size (https://learn.microsoft.com/power-pages/configure/webapi-azure-blob)
test('with DownloadViaSASUri false the portal streams the file in DownloadChunkSizeInKB reads', async (t) => {
  const sim = await fileApiFixture(t, {
    settings: {
      ...SETTINGS,
      'Site/FileManagement/DownloadViaSASUri': 'false',
      'Site/FileManagement/DownloadChunkSizeInKB': '1',
    },
  });
  const owner = browser(sim, OWNER);
  const bytes = Array.from({ length: 2600 }, (_, index) => String.fromCodePoint(97 + (index % 26))).join('');
  const token = await uploaded(owner, bytes);
  const streamed = await owner.download(token, 'annotation', { follow: false });
  assert.equal(streamed.status, 200);
  assert.equal(streamed.headers.get('content-type'), 'text/plain');
  assert.equal(streamed.headers.get('content-length'), '2600');
  assert.equal(await streamed.text(), bytes);
});

// A direct handler over a stub note and provider: GET the download route and answer { status, text, reads }.
async function streamedDownload(t, { size, settings, changeAt = null }) {
  const id = guid(61);
  const bytes = Buffer.from(Array.from({ length: size }, (_, index) => 97 + (index % 26)));
  const reads = [];
  const placeholder = { Name: 'big.txt', Type: 'text/plain', Size: size, Url: `invented-files/${id}/big.txt` };
  const storage = {
    async get(key, { range } = {}) {
      const start = range?.start ?? 0;
      const end = Math.min(range?.end ?? size - 1, size - 1);
      reads.push([start, end]);
      const etag = changeAt !== null && reads.length > changeAt ? '"v2"' : '"v1"';
      return {
        size,
        etag,
        contentType: 'text/plain',
        range: range ? { start, end } : null,
        body: [bytes.subarray(start, end + 1)],
      };
    },
  };
  const deps = {
    store: { clock: { now: () => 0 }, get: async () => ({ annotationid: id, filename: 'big.txt.azure.txt' }) },
    portal: { settings: { ...SETTINGS, ...settings } },
    identity: {},
    attachmentBody: async () => Buffer.from(JSON.stringify(placeholder)).toString('base64'),
    storage: () => storage,
    json: (res, status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    },
  };
  const server = http.createServer((req, res) =>
    handlePortalFileApi(req, res, new URL(req.url, 'http://invented.localhost'), deps),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/_api/file/download/annotation(${id})/blob/$value`;
  try {
    const response = await fetch(url);
    return { status: response.status, text: await response.text(), reads, bytes };
  } catch (error) {
    return { error, reads, bytes };
  }
}

// @test-kind contract: Mirage reads the blob in DownloadChunkSizeInKB ranges (default 4096 KB), each bound to the first read's ETag, so a blob replaced during the download ends the response instead of joining two versions
test('the streamed download reads DownloadChunkSizeInKB at a time and stops when the blob changes', async (t) => {
  const off = { 'Site/FileManagement/DownloadViaSASUri': 'false' };
  const chunked = await streamedDownload(t, {
    size: 2600,
    settings: { ...off, 'Site/FileManagement/DownloadChunkSizeInKB': '1' },
  });
  assert.equal(chunked.status, 200);
  assert.equal(chunked.text, chunked.bytes.toString());
  assert.deepEqual(chunked.reads, [
    [0, 1023],
    [1024, 2047],
    [2048, 2599],
  ]);
  const defaults = await streamedDownload(t, {
    size: 2600,
    settings: { ...off, 'Site/FileManagement/DownloadChunkSizeInKB': 'many' },
  });
  assert.deepEqual(defaults.reads, [[0, 2599]], 'an invalid chunk size keeps the 4096 KB default');
  const replaced = await streamedDownload(t, {
    size: 2600,
    settings: { ...off, 'Site/FileManagement/DownloadChunkSizeInKB': '1' },
    changeAt: 1,
  });
  assert.ok(replaced.error || replaced.text.length < 2600, 'the response ends short of the file');
});

// @test-kind contract: Mirage-own upload lifetime; an upload unused for an hour ends and its staged chunks are discarded
test('an upload unused for an hour expires', async (t) => {
  const clock = fixedClock(Date.now());
  const sim = await fileApiFixture(t, { clock });
  const owner = browser(sim, OWNER);
  const token = await started(owner);
  assert.equal((await owner.block(token, 0, '012345')).status, 204);
  clock.advance(3_600_001);
  await expectError(await owner.block(token, 6, '6789'), 'FU00010');
  await expectError(await owner.download(token), 'FU00012');
});

async function diskFixture(t, options) {
  const stateDir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-file-api-disk-'));
  ownedFixture(t).remove(() => fs.rm(stateDir, { recursive: true, force: true }));
  const sim = await fileApiFixture(t, { ...options, stateDir });
  const staged = async () => {
    try {
      return await fs.readdir(path.join(stateDir, 'cloud', 'staging'));
    } catch (cause) {
      if (cause.code === 'ENOENT') return [];
      throw cause;
    }
  };
  return { sim, staged, stateDir };
}

// @test-kind contract: an upload that ends without its file (expired, deleted or failed) leaves no staged chunks on the local-disk provider
test('an ended upload leaves no staged chunks on local disk', async (t) => {
  await t.test('abandoned, then swept after an hour', async (sub) => {
    const clock = fixedClock(Date.now());
    const { sim, staged } = await diskFixture(sub, { clock });
    const owner = browser(sim, OWNER);
    const token = await started(owner);
    assert.equal((await owner.block(token, 0, '012345')).status, 204);
    assert.equal((await staged()).length, 1);
    clock.advance(3_600_001);
    // The request that finds the expired upload discards it before it answers.
    await expectError(await owner.block(token, 6, '6789'), 'FU00010');
    assert.deepEqual(await staged(), []);
  });
  await t.test('deleted during the upload', async (sub) => {
    const { sim, staged } = await diskFixture(sub);
    const owner = browser(sim, OWNER);
    const token = await started(owner);
    assert.equal((await owner.block(token, 0, '012345')).status, 204);
    assert.equal((await staged()).length, 1);
    assert.equal((await owner.remove(token)).status, 204);
    assert.deepEqual(await staged(), []);
    await expectError(await owner.block(token, 6, '6789'), 'FU00010');
  });
  await t.test('a failed commit', async (sub) => {
    const { sim, staged, stateDir } = await diskFixture(sub);
    const owner = browser(sim, OWNER);
    const token = await started(owner);
    assert.equal((await owner.block(token, 0, '012345')).status, 204);
    // The staged first chunk disappears from the provider, so committing the file after the last chunk fails.
    const [dir] = await staged();
    const blocks = path.join(stateDir, 'cloud', 'staging', dir);
    for (const name of await fs.readdir(blocks)) await fs.rm(path.join(blocks, name));
    const last = await owner.block(token, 6, '6789');
    assert.ok(last.status >= 400, String(last.status));
    assert.deepEqual(await staged(), []);
    await expectError(await owner.block(token, 6, '6789'), 'FU00010');
    await expectError(await owner.download(token), 'FU00012');
  });
});

// @test-kind contract: a download streams with backpressure and stops reading the provider when the client goes away
test('a download the client abandons stops reading the stored file', async (t) => {
  const id = guid(60);
  let reads = 0,
    released = false;
  const total = 100_000;
  const chunk = Buffer.alloc(64 * 1024, 1);
  const store = {
    clock: { now: () => 0 },
    get: async () => ({ annotationid: id, filename: 'large.txt.azure.txt' }),
  };
  const placeholder = {
    Name: 'large.txt',
    Type: 'text/plain',
    Size: total * chunk.length,
    Url: `invented-files/${id}/large.txt`,
  };
  const storage = {
    async get() {
      async function* body() {
        try {
          for (let i = 0; i < total; i++) {
            reads++;
            yield chunk;
          }
        } finally {
          released = true;
        }
      }
      return { contentType: 'text/plain', body: body() };
    },
  };
  const deps = {
    store,
    // The portal streams the file itself only with DownloadViaSASUri false.
    portal: { settings: { ...SETTINGS, 'Site/FileManagement/DownloadViaSASUri': 'false' } },
    identity: {},
    attachmentBody: async () => Buffer.from(JSON.stringify(placeholder)).toString('base64'),
    storage: () => storage,
    json: (res, status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    },
  };
  let handled;
  const server = http.createServer((req, res) => {
    handled = handlePortalFileApi(req, res, new URL(req.url, 'http://invented.localhost'), deps);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const socket = net.connect(server.address().port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(
    ['GET /_api/file/download/annotation(' + id + ')/blob/$value HTTP/1.1', 'Host: invented.localhost', '', ''].join(
      '\r\n',
    ),
  );
  // The client reads the first bytes of the answer, then goes away.
  const first = await new Promise((resolve) => socket.once('data', resolve));
  assert.match(first.toString('latin1'), /^HTTP\/1\.1 200/);
  socket.destroy();
  assert.equal(await handled, true);
  assert.equal(released, true, 'the provider stream was released');
  assert.ok(reads < total, `read ${reads} of ${total} chunks after the client left`);
});
