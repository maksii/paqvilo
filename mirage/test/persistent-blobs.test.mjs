import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { persistentLevel, stateDirectoryOf } from '../lib/organization-host.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const CLIENT = '99999999-9999-4999-8999-999999999991';
const NOTE = '77777777-7777-4777-8777-7777777777b1';
const BODY = Buffer.from('invented note body '.repeat(20)).toString('base64');
// Above the 64 KiB pack DATA inline limit (PACK_INLINE_BODY_LIMIT): stored in <stateDir>/blobs, referenced by key.
const LARGE = Buffer.alloc(70 * 1024, 'invented large body ').toString('base64');
const ENTITY =
  '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute><attribute PhysicalName="x_doc"><Name>x_doc</Name><Type>file</Type><MaxSizeInKB>32768</MaxSizeInKB></attribute></attributes></entity></EntityInfo></Entity>';
const PORTAL = {
  'website.yml':
    'adx_name: Invented Site\nadx_websiteid: site\nadx_defaultlanguage: lang-en\nadx_website_language: 1033',
  'websitelanguage.yml': '- adx_websitelanguageid: lang-en\n  adx_name: English',
  'web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
  'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
  'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'web-templates/Main.webtemplate.source.html': '<p>home</p>',
};

async function write(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
}

async function fixture(t, { level, portal = false, extra = {} }) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'persistent-blobs-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  await write(root, {
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedBlobs</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/x_item/Entity.xml': ENTITY,
    'data.json': JSON.stringify({ items: [], notes: [] }),
    // A pack DATA file owns the note table, so an explicit level may write notes; the bytes go to the blob store.
    'pack.mjs':
      "export default { id: 'fx-blobs', name: 'Invented', description: 'Invented', matches: () => true, presets: () => ({})," +
      " dataFiles: [{ file: 'data.json', tables: { x_item: { path: ['items'], idColumn: 'x_itemid' }, annotation: { path: ['notes'], idColumn: 'annotationid' } } }] };",
    ...(portal ? Object.fromEntries(Object.entries(PORTAL).map(([name, body]) => [`portal/${name}`, body])) : {}),
  });
  const stateFile = path.join(root, 'state', 'state.json');
  const options = {
    solutionRoots: [path.join(root, 'solution')],
    projectRoot: root,
    port: 0,
    watch: false,
    stateFile,
    simulation: { level },
    packs: [path.join(root, 'pack.mjs')],
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
    ...extra,
    ...(portal ? { sourceDir: path.join(root, 'portal') } : { runtime: { kind: 'dataverse-api' } }),
  };
  // Every started runtime closes, even after a failed assertion, before the directory is removed.
  const start = async () => {
    const sim = await createSimulator(options);
    ownedFixture(t).add(() => sim.close());
    return sim;
  };
  return { root, stateFile, start };
}

async function json(response, status) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return text ? JSON.parse(text) : null;
}

async function client(sim, secret) {
  if (!secret)
    secret = (
      await json(
        await fetch(sim.url + (sim.adminUrl?.includes('__sim') ? '/__sim' : '/_sim') + '/api/dataverse/applications', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
          body: JSON.stringify({ appId: CLIENT, displayName: 'Invented client', roles: ['System Administrator'] }),
        }),
        201,
      )
    ).secret;
  const token = await json(
    await fetch(sim.dataverse.authority + '/oauth2/v2.0/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT,
        client_secret: secret,
        scope: sim.dataverse.origin + '/.default',
      }),
    }),
    200,
  );
  const api = (method, suffix, body) =>
    fetch(sim.dataverse.origin + '/api/data/v9.2' + suffix, {
      method,
      headers: {
        authorization: `Bearer ${token.access_token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { api, secret };
}

async function roundTrip(t, options, body = LARGE) {
  const { root, start } = await fixture(t, options);
  let sim = await start();
  const first = await client(sim);
  await json(
    await first.api('POST', '/annotations', {
      annotationid: NOTE,
      subject: 'Invented note',
      filename: 'n.txt',
      mimetype: 'text/plain',
      documentbody: body,
    }),
    204,
  );
  const report = sim.state().status?.simulation ?? sim.status?.().simulation;
  await sim.close();
  sim = await start();
  const second = await client(sim, first.secret);
  const read = await json(await second.api('GET', `/annotations(${NOTE})?$select=documentbody,subject`), 200);
  await sim.close();
  return { root, read, report, start, secret: first.secret };
}

const dataRow = async (root) => JSON.parse(await fs.readFile(path.join(root, 'data.json'), 'utf8')).notes[0];
const diagnosticsOf = async (sim) =>
  json(await fetch(sim.url + '/_sim/api/diagnostics', { headers: { 'x-sim-csrf': sim.csrf } }), 200);

// Every non-dry-run level shares this path (persistentLevel below), so one level proves the blob store.
test('a large note body lives in <stateDir>/blobs across a restart; a missing blob reads as a null body', async (t) => {
  const { root, read, report, start, secret } = await roundTrip(t, { level: 'simulation' });
  assert.equal(read.documentbody, LARGE);
  assert.ok((await fs.readdir(path.join(root, 'state', 'blobs'))).length, 'bytes live in the state blob directory');
  // Above the inline limit the pack DATA row references the bytes by key; it never carries them.
  const row = await dataRow(root);
  assert.equal(row.documentbody, null);
  assert.equal(row.__blobkey, `annotations/${NOTE}/1`);
  assert.ok(
    report.targets.some((target) => target.kind === 'blobs' && target.file === path.join(root, 'state', 'blobs')),
    'the report lists the blob directory',
  );

  // Missing blob: reported once at start, reads as null, $value answers 404 STORAGE_OBJECT_MISSING.
  await fs.rm(path.join(root, 'state', 'blobs'), { recursive: true, force: true });
  const sim = await start();
  const { api } = await client(sim, secret);
  const summary = JSON.stringify(await diagnosticsOf(sim));
  assert.match(summary, /STORAGE_OBJECTS_MISSING/);
  assert.ok(summary.includes(row.__blobkey), 'the summary names the first missing keys');
  const list = await json(await api('GET', '/annotations?$select=subject,documentbody'), 200);
  assert.deepEqual(
    list.value.map(({ subject, documentbody }) => ({ subject, documentbody })),
    [{ subject: 'Invented note', documentbody: null }],
  );
  assert.equal((await json(await api('GET', `/annotations(${NOTE})?$select=documentbody`), 200)).documentbody, null);
  const raw = await api('GET', `/annotations(${NOTE})/documentbody/$value`);
  assert.equal(raw.status, 404);
  assert.match(await raw.text(), /storage_object_missing/i); // the Web API envelope writes the code in lower case
  assert.match(
    JSON.stringify(await diagnosticsOf(sim)),
    /STORAGE_OBJECT_MISSING".*annotation|annotation.*STORAGE_OBJECT_MISSING"/s,
  );
});

test('a small note body stays inline in the pack DATA file, so the committed file reads without the blob directory', async (t) => {
  const { root, read, start } = await roundTrip(t, { level: 'simulation' }, BODY);
  assert.equal(read.documentbody, BODY);
  const row = await dataRow(root);
  assert.equal(row.documentbody, BODY);
  assert.equal(row.__blobkey, undefined);
  await fs.rm(path.join(root, 'state'), { recursive: true, force: true });
  const sim = await start();
  const { api } = await client(sim); // the state directory (and its registered client) is gone
  assert.equal((await json(await api('GET', `/annotations(${NOTE})?$select=documentbody`), 200)).documentbody, BODY);
});

test('a file column ($value) keeps its bytes across a restart at level simulation', async (t) => {
  // The x_item mapping with a file column in `fields`, the project mapping shape dataverse-files reads.
  const fields = {
    x_itemid: { dataverseType: 'primarykey' },
    x_name: { dataverseType: 'nvarchar' },
    x_doc: { dataverseType: 'file', MaxSizeInKB: 32768 },
  };
  const { start } = await fixture(t, {
    level: 'simulation',
    extra: {
      initial: {
        mappings: {
          x_item: {
            logicalName: 'x_item',
            entitySet: 'x_items',
            idColumn: 'x_itemid',
            nameColumn: 'x_name',
            relationships: {},
            fields,
          },
        },
      },
    },
  });
  const ITEM = '77777777-7777-4777-8777-7777777777b2';
  const bytes = Buffer.from('invented file column bytes');
  let sim = await start();
  const first = await client(sim);
  await json(await first.api('POST', '/x_items', { x_itemid: ITEM, x_name: 'Invented item' }), 204);
  const upload = await fetch(sim.dataverse.origin + `/api/data/v9.2/x_items(${ITEM})/x_doc`, {
    method: 'PATCH',
    body: bytes,
    headers: {
      authorization: await tokenHeader(sim, first.secret),
      'content-type': 'application/octet-stream',
      'x-ms-file-name': 'invented.txt',
    },
  });
  assert.equal(upload.status, 204, await upload.text());
  await sim.close();
  sim = await start();
  const download = await fetch(sim.dataverse.origin + `/api/data/v9.2/x_items(${ITEM})/x_doc/$value`, {
    headers: { authorization: await tokenHeader(sim, first.secret) },
  });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
});

async function tokenHeader(sim, secret) {
  const token = await json(
    await fetch(sim.dataverse.authority + '/oauth2/v2.0/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT,
        client_secret: secret,
        scope: sim.dataverse.origin + '/.default',
      }),
    }),
    200,
  );
  return `Bearer ${token.access_token}`;
}

test('the Power Pages host at level simulation keeps a note body across a restart', async (t) => {
  const { read } = await roundTrip(t, { level: 'simulation', portal: true });
  assert.equal(read.documentbody, LARGE);
});

test('dry-run keeps storage in memory and writes no blobs directory', async (t) => {
  const { stateFile, start } = await fixture(t, { level: 'dry-run' });
  const sim = await start();
  const { api } = await client(sim);
  await json(
    await api('POST', '/annotations', { annotationid: NOTE, subject: 'Invented note', documentbody: BODY }),
    204,
  );
  assert.equal(sim.state().status.providers.storage.providers.find((entry) => entry.id === 'local').kind, 'memory');
  await sim.close();
  await assert.rejects(fs.stat(path.join(path.dirname(stateFile), 'blobs')), { code: 'ENOENT' });
  assert.equal(stateDirectoryOf({ stateFile, simulation: { level: 'dry-run' } }), null);
});

test('persistentLevel: only dry-run is memory-only', () => {
  assert.equal(persistentLevel('dry-run'), false);
  for (const level of ['simulation', 'deep', null, undefined]) assert.equal(persistentLevel(level), true);
  assert.equal(stateDirectoryOf({ stateFile: path.join('x', 'state.json'), simulation: null }), path.resolve('x'));
  assert.equal(stateDirectoryOf({ stateFile: null, simulation: { level: 'deep' } }), null);
});
