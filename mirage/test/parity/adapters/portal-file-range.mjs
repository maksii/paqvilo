// Replay the portable file requests through Mirage's portal listener.
// The native route, schema names and identities are replaced by invented equivalents.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../../../server.mjs';
import { makeTemporaryDirectory, removeFixtureDirectory } from '../../../testing/owned-fixture.mjs';
import { signInHeaders } from '../../../testing/session.mjs';

const RECORD = '70000000-0000-4000-8000-000000000001';
const CONTACT = '70000000-0000-4000-8000-000000000002';
const SITE = '70000000-0000-4000-8000-000000000003';
const FILE_ROUTE = '/_api/range_fixtures(' + RECORD + ')/range_file';

const initial = () => ({
  version: 1,
  mappings: {
    range_fixture: {
      entitySet: 'range_fixtures',
      idColumn: 'range_fixtureid',
      fields: { range_file: { dataverseType: 'file' } },
    },
    contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
  },
  tables: {
    range_fixture: [{ range_fixtureid: RECORD }],
    contact: [{ contactid: CONTACT, fullname: 'Invented fixture reader' }],
  },
  permissions: [
    { id: 'file-fixture', entity: 'range_fixture', scope: 'global', roles: ['Member'], operations: ['read', 'update'] },
  ],
  settings: { permissionMode: 'enforce' },
  simulator: { mode: 'local', pageMode: 'local', endpoints: [] },
});

export default async function run({ fileBase64, range, observed }) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-replay-portal-file-'));
  let app;
  try {
    await Promise.all([
      fs.writeFile(
        path.join(directory, 'website.yml'),
        'adx_websiteid: ' + SITE + '\nadx_name: Invented file range site\n',
      ),
      fs.writeFile(
        path.join(directory, 'sitesetting.yml'),
        "- adx_name: Webapi/range_fixture/enabled\n  adx_value: 'true'\n- adx_name: Webapi/range_fixture/fields\n  adx_value: range_file\n",
      ),
    ]);
    app = await createSimulator({ sourceDir: directory, initial: initial(), observed, watch: false, port: 0 });
    const { cookie } = signInHeaders(app, CONTACT, { roles: ['Member'] });
    const upload = await fetch(app.url + FILE_ROUTE, {
      method: 'PATCH',
      headers: {
        cookie,
        __RequestVerificationToken: app.portalToken,
        'content-type': 'application/octet-stream',
        'x-ms-file-name': 'synthetic.txt',
      },
      body: Buffer.from(fileBase64, 'base64'),
    });
    assert.equal(upload.status, 204, 'Synthetic file provisioning must succeed before replay.');

    const response = await fetch(app.url + FILE_ROUTE + '/$value', {
      headers: { cookie, ...(range === null ? {} : { Range: range }) },
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      contentRange: response.headers.get('content-range'),
      acceptRanges: response.headers.get('accept-ranges'),
      contentLength: response.headers.get('content-length'),
      hasValidator: response.headers.has('etag'),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    await app?.close();
    await removeFixtureDirectory(directory);
  }
}
