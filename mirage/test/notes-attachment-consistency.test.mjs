// @test-kind contract: local notes keep the regarding read, provider pages and fallback file metadata consistent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulatorFixture } from './fixtures/source-site.mjs';
import { signInHeaders } from '../testing.mjs';

const guid = (n) => `63000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const site = guid(1);
const contact = guid(2);
const target = guid(3);
const earlier = guid(4);
const oldContent = 'first';
const newContent = 'replacement bytes';
const standard = '2026-01-02T00:00:00Z';
const note = (id, createdon) => ({
  annotationid: id,
  subject: 'Invented note',
  notetext: '*WEB*Invented note',
  objectid: { id: contact, logical_name: 'contact' },
  filename: 'first.txt',
  mimetype: 'text/plain',
  documentbody: Buffer.from(oldContent).toString('base64'),
  createdon,
});

async function fixture(t, routed, hideBody = false) {
  const app = await simulatorFixture(t, {
    prefix: 'notes-attachment-consistency-',
    files: {
      'website.yml': `adx_websiteid: ${site}\nadx_name: Invented notes`,
      'web-pages/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
      'sitesetting.yml': [
        '- adx_sitesettingid: notes-webapi-enabled\n  adx_name: Webapi/annotation/enabled\n  adx_value: "true"',
        '- adx_sitesettingid: notes-webapi-fields\n  adx_name: Webapi/annotation/fields\n  adx_value: subject,documentbody',
      ].join('\n'),
    },
    port: 0,
    watch: false,
    initial: {
      version: 1,
      mappings: {
        contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
        annotation: {
          entitySet: 'annotations',
          idColumn: 'annotationid',
          nameColumn: 'subject',
          ...(hideBody ? { fields: { documentbody: { dataverseType: 'nvarchar', validForRead: false } } } : {}),
        },
      },
      permissions: [
        { id: 'contact-read', entity: 'contact', scope: 'global', roles: ['Reader'], operations: ['read'] },
        { id: 'note-read', entity: 'annotation', scope: 'global', roles: ['Reader'], operations: ['read'] },
      ],
      tables: {
        contact: [{ contactid: contact, fullname: 'Invented reader' }],
        annotation: [note(earlier, '2026-01-01T00:00:00Z'), ...(routed ? [note(target, standard)] : [])],
      },
      settings: { permissionMode: 'enforce' },
      simulator: { mode: 'local', pageMode: 'local', permissionSource: 'configured' },
    },
  });
  await app.store.transact(() => {
    const rows = app.store.tableRows('annotation');
    if (!routed) rows.push(note(target, standard));
    const stored = rows.find((row) => row.annotationid === target);
    assert.equal(Boolean(stored.__blobkey), routed);
    stored.filesize = null;
  });
  const tokens = signInHeaders(app, contact, { roles: ['Reader'] });
  const post = () =>
    fetch(`${app.url}/_services/entity-notes/${site}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', __RequestVerificationToken: app.portalToken, ...tokens },
      body: JSON.stringify({
        regarding: { LogicalName: 'contact', Id: contact },
        page: 1,
        pageSize: 1,
        orders: [{ Attribute: 'createdon', Direction: 1 }],
      }),
    });
  const webApi = () =>
    fetch(`${app.url}/_api/annotations(${target})?$select=subject,documentbody`, {
      headers: { __RequestVerificationToken: app.portalToken, ...tokens },
    });
  const download = () => fetch(`${app.url}/_entity/annotation/${target}/${site}`, { headers: tokens });
  return { store: app.store, post, webApi, download };
}

async function replaceAfterNotesRead(t, store, post) {
  const selected = Promise.withResolvers();
  const resume = Promise.withResolvers();
  t.signal.addEventListener('abort', resume.resolve, { once: true });
  const fetchXml = store.fetchXml.bind(store);
  const readOperation = store.readOperation.bind(store);
  let pages = 0;
  let reads = 0;
  let lastPage = false;
  let gated = false;
  const query = t.mock.method(store, 'fetchXml', (xml, identity, options) => {
    if (options?.portalMasked || !xml.includes('<entity name="annotation"')) return fetchXml(xml, identity, options);
    const result = fetchXml(xml.replace('<fetch count="5000"', '<fetch count="1"'), identity, options);
    pages++;
    lastPage = !result.more_records;
    return result;
  });
  const boundary = t.mock.method(store, 'readOperation', async (fn) => {
    reads++;
    const result = await readOperation(fn);
    if (lastPage && !gated) {
      gated = true;
      selected.resolve({ reads, pages });
      await resume.promise;
    }
    return result;
  });
  const pending = post();
  let observed;
  try {
    observed = await Promise.race([
      selected.promise,
      pending.then((res) => assert.fail(`The notes read did not reach its boundary (HTTP ${res.status})`)),
    ]);
    await store.transact(() => {
      const row = store.tableRows('annotation').find((item) => item.annotationid === target);
      Object.assign(row, {
        filename: 'replacement.txt',
        documentbody: Buffer.from(newContent).toString('base64'),
        __blobkey: null,
      });
    });
  } finally {
    resume.resolve();
    query.mock.restore();
    boundary.mock.restore();
  }
  return { observed, response: await pending };
}

async function currentNote(response) {
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual([data.ItemCount, data.PageCount, data.MoreRecords], [2, 2, true]);
  assert.deepEqual(
    data.Records.map((row) => row.Id),
    [target],
  );
  return data.Records[0];
}

for (const [label, routed, expected] of [
  ['inline', false, '5 bytes'],
  ['storage-backed', true, '0 bytes'],
]) {
  test(`notes list keeps its ${label} attachment size tied to the admitted row version`, async (t) => {
    const { store, post } = await fixture(t, routed);
    const { observed, response } = await replaceAfterNotesRead(t, store, post);
    const admitted = await currentNote(response);
    assert.equal(admitted.AttachmentFileName, 'first.txt');
    assert.equal(admitted.AttachmentSizeDisplay, expected);
    assert.deepEqual(observed, { reads: 1, pages: 2 });
    const fresh = await currentNote(await post());
    assert.equal(fresh.AttachmentFileName, 'replacement.txt');
    assert.equal(fresh.AttachmentSizeDisplay, `${Buffer.byteLength(newContent)} bytes`);
  });
}

// @test-kind security: a readable attachment name does not grant body-derived size when the body column is hidden.
test('notes list keeps its attachment fallback size empty when body field security denies read', async (t) => {
  const { post } = await fixture(t, true, true);
  const note = await currentNote(await post());
  assert.equal(note.AttachmentFileName, 'first.txt');
  assert.equal(note.AttachmentSizeDisplay, '0 bytes');
});

// Holds the request's first read of the store (the admitted rows), commits write, then lets the request load the provider
// bytes it captured.
async function writeDuringLoad(t, store, send, write) {
  const admitted = Promise.withResolvers();
  const resume = Promise.withResolvers();
  t.signal.addEventListener('abort', resume.resolve, { once: true });
  const readOperation = store.readOperation.bind(store);
  let gated = false;
  const boundary = t.mock.method(store, 'readOperation', async (fn) => {
    const result = await readOperation(fn);
    if (!gated) {
      gated = true;
      admitted.resolve();
      await resume.promise;
    }
    return result;
  });
  const pending = send();
  try {
    await Promise.race([
      admitted.promise,
      pending.then((res) => assert.fail(`The read did not reach its boundary (HTTP ${res.status})`)),
    ]);
    boundary.mock.restore();
    await store.transact(() => write(store.tableRows('annotation')));
  } finally {
    resume.resolve();
    boundary.mock.restore();
  }
  return pending;
}

for (const [surface, request, read] of [
  [
    'Web API documentbody',
    'webApi',
    async (response) => {
      assert.equal(response.status, 200);
      return (await response.json()).documentbody;
    },
  ],
  ['notes list size', 'post', async (response) => (await currentNote(response)).AttachmentSizeDisplay],
  [
    'attachment download',
    'download',
    async (response) => {
      assert.equal(response.status, 200);
      return response.text();
    },
  ],
]) {
  test(`${surface} keeps a storage-backed note's bytes when another note is written during the load`, async (t) => {
    const app = await fixture(t, true);
    const expected = await read(await app[request]());
    assert.ok(expected && expected !== '0 bytes', 'the baseline read carries the stored bytes');
    const unrelated = (rows) =>
      Object.assign(
        rows.find((item) => item.annotationid === earlier),
        { subject: 'Unrelated edit', documentbody: null },
      );
    assert.equal(await read(await writeDuringLoad(t, app.store, app[request], unrelated)), expected);
  });
}

test('Web API documentbody drops captured bytes when the note is re-created under the same provider key', async (t) => {
  const { store, webApi } = await fixture(t, true);
  const recreate = (rows) => {
    const index = rows.findIndex((item) => item.annotationid === target);
    const removed = rows.splice(index, 1)[0];
    rows.push({ ...removed, filename: 'recreated.txt', createdon: '2026-01-03T00:00:00Z' });
  };
  const response = await writeDuringLoad(t, store, webApi, recreate);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).documentbody, null);
});
