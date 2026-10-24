// Portal storage routes (organization-host.mjs providers, dataverse-storage-routing.mjs): note bodies leave state and are read
// back by the portal readers, web files stored in Azure Blob Storage come from route portalWebFiles, cloud attachments put
// their bytes on route portalCloudAttachments behind the documented placeholder note, staged uploads are provider blocks,
// and a runtime without a state directory uses the in-memory provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { signInHeaders } from '../testing.mjs';
import { DataStore } from '../lib/data.mjs';
import { submitPortalForm } from '../lib/form-service.mjs';
import { createLocalDiskStorage } from '../lib/storage-local-disk.mjs';
import { createMemoryStorage } from '../lib/storage-memory.mjs';
import { guardProvider } from '../lib/storage-provider.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const SITE = '8c3d9b2a-7c3e-4a5b-9d6e-1a2b3c4d5e81';
const NOTE = 'a0000000-0000-4000-8000-000000000081';
const WEBFILE = 'b0000000-0000-4000-8000-000000000081';
const CONTACT = 'c0000000-0000-4000-8000-000000000081';
const CLIENT = '99999999-9999-4999-8999-999999999981';

async function portalFixture(t, { settings = [], providers } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-storage-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'portal'),
    stateDir = path.join(dir, 'state');
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented Storage`,
    'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
    'web-files/logo.webfile.yml': `adx_webfileid: ${WEBFILE}\nadx_name: logo.txt\nadx_partialurl: logo.txt\nadx_parentpageid: home\nfilename: logo.txt`,
    'web-files/logo.txt': 'export bytes',
    'sitesetting.yml':
      settings
        .map(
          ([name, value], index) =>
            `- adx_sitesettingid: 5e000000-0000-4000-8000-0000000000${80 + index}\n  adx_name: ${name}\n  adx_value: "${value}"`,
        )
        .join('\n') || '[]',
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await fs.writeFile(path.join(source, name), body);
  }
  await fs.mkdir(stateDir, { recursive: true });
  const sim = await createSimulator({
    sourceDir: source,
    stateFile: path.join(stateDir, 'state.json'),
    port: 0,
    watch: false,
    ...(providers ? { providers } : {}),
    initial: {
      version: 1,
      mappings: {
        contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
        annotation: { entitySet: 'annotations', idColumn: 'annotationid' },
      },
      tables: {
        contact: [{ contactid: CONTACT, fullname: 'Invented Person', statecode: 0 }],
        annotation: [
          {
            annotationid: NOTE,
            subject: 'Invented note',
            filename: 'evidence.txt',
            mimetype: 'text/plain',
            filesize: 8,
            documentbody: Buffer.from('evidence').toString('base64'),
            objectid: { id: CONTACT, logical_name: 'contact' },
          },
        ],
      },
      permissions: [],
      settings: { permissionMode: 'permissive' },
      simulator: { mode: 'local', pageMode: 'local', live: { allowWrites: false }, endpoints: [] },
    },
  });
  ownedFixture(t).add(() => sim.close());
  return { sim, dir, stateDir };
}

test('a portal note download reads the body from the storage provider once it has left state', async (t) => {
  const { sim } = await portalFixture(t);
  const row = sim.store.state.tables.annotation.find((item) => item.annotationid === NOTE);
  assert.equal(row.documentbody, null, 'the body moved to the annotations route');
  assert.match(row.__blobkey, /^annotations\//);
  const response = await fetch(`${sim.url}/_entity/annotation/${NOTE}`, { headers: signInHeaders(sim, CONTACT) });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'evidence');
});

test('a standalone runtime without a state directory routes note bodies to the in-memory provider', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'standalone-storage-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const solution = path.join(root, 'solution');
  await fs.mkdir(path.join(solution, 'Other'), { recursive: true });
  await fs.writeFile(
    path.join(solution, 'Other', 'Solution.xml'),
    '<ImportExportXml><SolutionManifest><UniqueName>InventedStorage</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  );
  const sim = await createSimulator({
    runtime: { kind: 'dataverse-api' },
    solutionRoots: [solution],
    projectRoot: root,
    port: 0,
    watch: false,
    simulation: { level: 'dry-run' },
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
  });
  ownedFixture(t).add(() => sim.close());
  const status = sim.status();
  assert.equal(status.providers.storage.providers.find((entry) => entry.id === 'local').kind, 'memory');
  assert.equal(status.providers.storage.providers.find((entry) => entry.id === 'local').ready, true);
  const registration = await (
    await fetch(sim.url + '/_sim/api/dataverse/applications', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
      body: JSON.stringify({ appId: CLIENT, displayName: 'Invented client', roles: ['System Administrator'] }),
    })
  ).json();
  const token = await (
    await fetch(sim.dataverse.authority + '/oauth2/v2.0/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT,
        client_secret: registration.secret,
        scope: sim.dataverse.origin + '/.default',
      }),
    })
  ).json();
  const api = (method, suffix, body) =>
    fetch(sim.dataverse.origin + '/api/data/v9.2' + suffix, {
      method,
      headers: {
        authorization: `Bearer ${token.access_token}`,
        ...(body ? { 'content-type': 'application/json', prefer: 'return=representation' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const created = await (
    await api('POST', '/annotations', {
      subject: 'Invented',
      filename: 'a.txt',
      mimetype: 'text/plain',
      documentbody: Buffer.from('memory bytes').toString('base64'),
    })
  ).json();
  assert.equal(
    sim.store.state.tables.annotation.find((row) => row.annotationid === created.annotationid).documentbody,
    null,
  );
  const read = await (await api('GET', `/annotations(${created.annotationid})?$select=documentbody`)).json();
  assert.equal(Buffer.from(read.documentbody, 'base64').toString(), 'memory bytes');
});

test('an Azure Blob Storage web file is served from route portalWebFiles and never from the export', async (t) => {
  const providers = { storage: { cloud: { kind: 'local-disk', root: 'cloud' } }, routes: { portalWebFiles: 'cloud' } };
  const { sim, stateDir } = await portalFixture(t, {
    settings: [['WebFiles/StorageLocation', 'AzureBlobStorage']],
    providers,
  });
  // The project put the object with its own provider over the same directory (before the simulator opens it).
  const cloud = createLocalDiskStorage({ root: path.join(stateDir, 'cloud') });
  await cloud.put(`webfiles/${WEBFILE}/logo.txt`, Buffer.from('cloud bytes'));
  await cloud.close();
  const served = await fetch(`${sim.url}/logo.txt`);
  assert.equal(served.status, 200);
  assert.equal(await served.text(), 'cloud bytes');
});

test('an Azure Blob Storage web file without a portalWebFiles provider is unavailable', async (t) => {
  const { sim } = await portalFixture(t, { settings: [['WebFiles/StorageLocation', 'AzureBlobStorage']] });
  const response = await fetch(`${sim.url}/logo.txt`);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /export bytes/);
  const state = await (await fetch(`${sim.url}/__sim/api/diagnostics`, { headers: { 'x-sim-csrf': sim.csrf } })).text();
  assert.match(state, /WEBFILE_CLOUD_STORAGE_UNAVAILABLE/);
});

test('staged portal uploads are provider blocks committed by the last block', async (t) => {
  const { sim, stateDir } = await portalFixture(t);
  const headers = { ...signInHeaders(sim, CONTACT), __requestverificationtoken: sim.csrf };
  const started = await fetch(`${sim.url}/_api/file/InitializeFileUpload/note`, {
    method: 'POST',
    headers: { ...headers, 'x-ms-file-name': 'upload.txt', 'x-ms-file-size': '10', 'content-type': 'text/plain' },
  });
  assert.equal(started.status, 200, await started.clone().text());
  const { AnnotationId: id, FileContinuationToken: token } = await started.json();
  // The upload belongs to the browser session the initialisation started (its visitor cookie).
  const visitor = started.headers.get('set-cookie')?.split(';')[0];
  if (visitor) headers.cookie = [headers.cookie, visitor].filter(Boolean).join('; ');
  for (const [offset, part] of [
    [0, '01234'],
    [5, '56789'],
  ]) {
    const block = await fetch(`${sim.url}/_api/file/UploadFileBlock/note?noteId=${id}&offset=${offset}`, {
      method: 'PUT',
      headers: { ...headers, 'x-ms-file-continuation-token': token, 'content-type': 'application/octet-stream' },
      body: part,
    });
    assert.equal(block.status, 204, await block.text());
  }
  const local = createLocalDiskStorage({ root: path.join(stateDir, 'blobs') });
  t.after(() => local.close());
  const { body } = await local.get(`staged/${id}`);
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), '0123456789');
});

async function formFixture() {
  const store = await new DataStore({
    state: {
      mappings: {
        contact: { entitySet: 'contacts', idColumn: 'contactid' },
        annotation: { entitySet: 'annotations', idColumn: 'annotationid' },
      },
      tables: { contact: [], annotation: [] },
      settings: { permissionMode: 'permissive' },
      permissions: [],
    },
  }).init();
  const portal = {
    settings: { 'FileStorage/CloudStorageAccount': 'inventedaccount' },
    forms: [{ id: 'notes', mode: 100000000, metadata: { adx_attachfile: true } }],
  };
  return {
    portal,
    store,
    schemas: { notes: { entity: 'contact', fields: [{ name: 'fullname' }] } },
    identity: { id: CONTACT, roles: [] },
  };
}
const upload = { name: 'Report 1.pdf', type: 'application/pdf', content: Buffer.from('pdf bytes').toString('base64') };

test('a cloud attachment puts its bytes on route portalCloudAttachments behind a placeholder note', async () => {
  const options = await formFixture();
  const cloud = guardProvider(createMemoryStorage({ id: 'cloud' }));
  const saved = await submitPortalForm(
    'entityform',
    'notes',
    { values: { fullname: 'Invented' }, attachments: [upload] },
    { ...options, cloudAttachments: () => cloud },
  );
  const [note] = options.store.state.tables.annotation;
  assert.equal(note.filename, 'Report 1.pdf.txt');
  assert.equal(note.mimetype, 'text/plain');
  const placeholder = JSON.parse(Buffer.from(note.documentbody, 'base64').toString());
  assert.deepEqual(Object.keys(placeholder), ['Name', 'Type', 'Size', 'Url']);
  assert.deepEqual([placeholder.Name, placeholder.Type, placeholder.Size], ['Report 1.pdf', 'application/pdf', 9]);
  const { body } = await cloud.get(placeholder.Url);
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), 'pdf bytes');
  assert.ok(saved.recordId);
});

test('a cloud attachment without route portalCloudAttachments fails the save and stores nothing', async () => {
  const options = await formFixture();
  const diagnostics = [];
  const missing = () => {
    throw Object.assign(new Error("Storage route 'portalCloudAttachments' is not configured."), {
      diagnostic: 'PROVIDER_ROUTE_MISSING',
    });
  };
  await assert.rejects(
    submitPortalForm(
      'entityform',
      'notes',
      { values: { fullname: 'Invented' }, attachments: [upload] },
      { ...options, cloudAttachments: missing, diagnostic: (entry) => diagnostics.push(entry) },
    ),
    (error) => error.status === 500 && error.code === 'PROVIDER_ROUTE_MISSING',
  );
  assert.equal(diagnostics[0].code, 'PROVIDER_ROUTE_MISSING');
  assert.deepEqual(options.store.state.tables.annotation, []);
  assert.deepEqual(options.store.state.tables.contact, []);
});

test('the portal Web API reads a stored note body back for documentbody', async (t) => {
  const { sim } = await portalFixture(t, {
    settings: [
      ['Webapi/annotation/enabled', 'true'],
      ['Webapi/annotation/fields', 'documentbody,filename'],
    ],
  });
  const headers = signInHeaders(sim, CONTACT);
  const entity = await fetch(`${sim.url}/_api/annotations(${NOTE})?$select=documentbody,filename`, { headers });
  const body = await entity.json();
  assert.equal(entity.status, 200, JSON.stringify(body));
  assert.equal(Buffer.from(body.documentbody, 'base64').toString(), 'evidence');
  const property = await fetch(`${sim.url}/_api/annotations(${NOTE})/documentbody`, { headers });
  assert.equal(property.status, 200);
  assert.equal(Buffer.from((await property.json()).value, 'base64').toString(), 'evidence');
});
