// The file control's download link, GET /File/download.aspx?Entity=&Attribute=&Id= (lib/portal-file-download.mjs), over
// an invented table with a file column and the visitor's table permissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { ownedFixture, ownedClose, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const SITE = '5d000000-0000-4000-8000-000000000001';
const MINE = '5d000000-0000-4000-8000-000000000002';
const THEIRS = '5d000000-0000-4000-8000-000000000003';
const EMPTY = '5d000000-0000-4000-8000-000000000004';
const CONTACT = '5d000000-0000-4000-8000-000000000005';
const PAYLOAD = Buffer.from('invented file column payload '.repeat(8), 'utf8');

async function simulator(t, { applicationUser = null } = {}) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-file-download-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'website.yml'), `adx_websiteid: ${SITE}\nadx_name: Example`);
  await fs.writeFile(
    path.join(dir, 'Home.webpage.yml'),
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
  );
  const initial = {
    version: 1,
    mappings: {
      x_case: {
        entitySet: 'x_cases',
        idColumn: 'x_caseid',
        nameColumn: 'x_name',
        fields: { x_name: { dataverseType: 'nvarchar' }, x_file: { dataverseType: 'file' } },
      },
      contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname', fields: {} },
    },
    tables: {
      x_case: [
        { x_caseid: MINE, x_name: 'Mine', x_owner: CONTACT },
        { x_caseid: THEIRS, x_name: 'Theirs', x_owner: null },
        { x_caseid: EMPTY, x_name: 'Empty', x_owner: CONTACT },
      ],
      contact: [{ contactid: CONTACT, fullname: 'Invented Visitor' }],
      ...(applicationUser
        ? { systemuser: [{ systemuserid: applicationUser, fullname: 'Invented application user', isdisabled: false }] }
        : {}),
    },
    permissions: [
      {
        id: 'own',
        entity: 'x_case',
        scope: 'contact',
        field: 'x_owner',
        roles: ['Member'],
        operations: ['read'],
      },
    ],
    settings: { permissionMode: 'enforce' },
    simulator: { mode: 'local', pageMode: 'local', live: { origin: null }, endpoints: [] },
  };
  const app = ownedClose(
    t,
    await createSimulator({
      sourceDir: dir,
      stateFile: path.join(dir, 'state.json'),
      initial,
      watch: false,
      observed: applicationUser
        ? {
            portalApplicationUserId: applicationUser,
            evidence: 'Invented loopback application principal without a field-security profile.',
          }
        : null,
    }),
  );
  const seam = (id, name) =>
    app.store.recordPipeline.fileContentInternal({
      principal: {
        userId: CONTACT,
        evidence: 'invented file column fixture',
        grants: [{ entity: 'x_case', operations: ['read', 'update'] }],
      },
      operation: 'upload',
      entity: 'x_case',
      id,
      column: 'x_file',
      content: PAYLOAD,
      fileName: name,
    });
  await seam(MINE, 'invented-file.txt');
  await seam(THEIRS, 'theirs.txt');
  const { cookie } = signInHeaders(app, CONTACT, { roles: ['Member'] });
  const download = (query, headers = { cookie }) => fetch(`${app.url}/File/download.aspx?${query}`, { headers });
  return { app, download };
}

// @test-kind observation: hosted session F2 fileapi runs a and b (form-file-control, follow-link:1): the file control links /File/download.aspx?Entity=&Attribute=&Id= and the link answers 200 with the bytes, Cache-Control private, Content-Type application/octet-stream, Content-Disposition attachment; filename=<name> and Content-Length, without a storage redirect
test('the file control download link answers the stored bytes as an attachment', async (t) => {
  const { download } = await simulator(t);
  const response = await download(`Entity=x_case&Attribute=x_file&Id=${MINE}`);
  assert.equal(response.status, 200);
  assert.equal(response.redirected, false);
  assert.equal(response.headers.get('cache-control'), 'private');
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename=invented-file.txt');
  assert.equal(response.headers.get('content-length'), String(PAYLOAD.length));
  // Not in the capture: Mirage adds nosniff as on /_api file reads (a deliberate difference).
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PAYLOAD);
});

// @test-kind security: the download link reads as the visitor: a record outside the visitor's table permission Read, an anonymous request, an empty column, a column that is not a file column, malformed parameters and a missing record all answer the same 404 with one X-Sim-Error-Code, so record existence is not revealed
test('the download link refuses records the visitor cannot read and malformed requests', async (t) => {
  const { download } = await simulator(t);
  for (const [query, code, headers] of [
    [`Entity=x_case&Attribute=x_file&Id=${THEIRS}`, 'FileDownloadNotFound'],
    [`Entity=x_case&Attribute=x_file&Id=${MINE}`, 'FileDownloadNotFound', {}],
    [`Entity=x_case&Attribute=x_file&Id=${EMPTY}`, 'FileDownloadNotFound'],
    [`Entity=x_case&Attribute=x_name&Id=${MINE}`, 'FileDownloadNotFound'],
    [`Entity=x_unknown&Attribute=x_file&Id=${MINE}`, 'FileDownloadNotFound'],
    ['Entity=x_case&Attribute=x_file&Id=not-a-guid', 'FileDownloadNotFound'],
    [`Entity=x_case&Attribute=x_file&Id=5d000000-0000-4000-8000-0000000000ff`, 'FileDownloadNotFound'],
  ]) {
    const response = await download(query, headers);
    assert.equal(response.status, 404, query);
    assert.equal(response.headers.get('x-sim-error-code'), code, query);
    assert.equal(await response.text(), 'Not Found', query);
  }
});

// @test-kind security: the download link applies the reader's column security as /_api/<set>(id)/<column>/$value does: a secured file column the visitor holds no field permission for answers 404 without the bytes
test('the download link refuses a secured file column the visitor cannot read', async (t) => {
  const { app, download } = await simulator(t, { applicationUser: '5d000000-0000-4000-8000-000000000006' });
  assert.equal((await download(`Entity=x_case&Attribute=x_file&Id=${MINE}`)).status, 200, 'readable before securing');
  await app.store.transact(() => {
    app.store.state.mappings.x_case.fields.x_file.columnMetadata = { isSecured: true };
  });
  const response = await download(`Entity=x_case&Attribute=x_file&Id=${MINE}`);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('x-sim-error-code'), 'FileDownloadNotFound');
  assert.equal(await response.text(), 'Not Found');
});
