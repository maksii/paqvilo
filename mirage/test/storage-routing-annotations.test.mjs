// Note documentbody and attachment body through the storage routing extension, with a local-disk storage router and without
// one: the row keeps no base64, reads answer the column with the same value, and deletes and replacements free the blobs.
// @test-kind contract: Paqvilo's own storage routing design; a failed provider put fails the note write.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MODES, b64, routingApi, tempRoot, widgetRef } from './storage-routing-fixture.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';

const NOTE = '77777777-7777-4777-8777-7777777777c1';
const BODY = b64('invented note body '.repeat(40));
const note = (id = NOTE, documentbody = BODY) => ({
  annotationid: id,
  subject: 'Invented note',
  filename: 'note.txt',
  mimetype: 'text/plain',
  documentbody,
});
const annotationKeys = async (h) => (await h.blobKeys()).filter((key) => key.startsWith('annotations/'));
const row = (h, logical, id) => h.store.tableRows(logical).find((r) => r[`${logical}id`] === id);
// Fields that differ between two runtimes for the same record.
const stable = (json) =>
  Object.fromEntries(
    Object.entries(json).filter(
      ([key]) => !/^@odata\.context$|on$|on@|_value$|_value@|versionnumber|@odata\.etag/.test(key),
    ),
  );

test('a note read answers the same body and columns with and without a storage router', async (t) => {
  const answers = [];
  for (const mode of MODES) {
    const h = await routingApi(t, { storage: mode.storage });
    assert.equal((await h.call('POST', 'annotations', note())).status, 204);
    const read = await h.call('GET', `annotations(${NOTE})`);
    assert.equal(read.status, 200);
    assert.equal(read.json.documentbody, BODY);
    assert.equal(Object.hasOwn(read.json, '__blobkey'), false);
    answers.push(stable(read.json));
  }
  assert.deepEqual(answers[0], answers[1]);
});

for (const mode of MODES) {
  test(`a created note keeps no base64 in state and reads back through $select ${mode.label}`, async (t) => {
    const root = await tempRoot(t);
    const file = path.join(root, 'state.json');
    const h = await routingApi(t, { storage: mode.storage, root, file });
    assert.equal((await h.call('POST', 'annotations', note())).status, 204);
    const stored = row(h, 'annotation', NOTE);
    const saved = await fs.readFile(file, 'utf8');
    if (mode.storage) {
      assert.equal(stored.documentbody, null);
      assert.equal(stored.__blobkey, `annotations/${NOTE}/1`);
      assert.deepEqual([stored.filename, stored.mimetype], ['note.txt', 'text/plain']);
      assert.equal(saved.includes(BODY.slice(0, 40)), false, 'the saved state holds no note base64');
      assert.deepEqual(await annotationKeys(h), [`annotations/${NOTE}/1`]);
    } else {
      assert.equal(stored.documentbody, BODY);
      assert.equal(saved.includes(BODY.slice(0, 40)), true);
    }
    let reads = 0;
    if (h.provider) {
      const get = h.provider.get;
      h.provider.get = (...args) => {
        reads += 1;
        return get(...args);
      };
    }
    const subjectOnly = await h.call('GET', `annotations(${NOTE})?$select=subject`);
    assert.equal(subjectOnly.json.subject, 'Invented note');
    assert.equal(Object.hasOwn(subjectOnly.json, 'documentbody'), false);
    assert.equal(reads, 0, 'a read without documentbody does not load the blob');
    const selected = await h.call('GET', `annotations?$select=documentbody,filename&$filter=annotationid eq ${NOTE}`);
    assert.equal(selected.json.value[0].documentbody, BODY);
    if (mode.storage) assert.equal(reads, 1);
  });

  test(`replacing, clearing and deleting a note frees its blobs after commit ${mode.label}`, async (t) => {
    const h = await routingApi(t, { storage: mode.storage });
    await h.call('POST', 'annotations', note());
    const replacement = b64('replacement body');
    assert.equal((await h.call('PATCH', `annotations(${NOTE})`, { documentbody: replacement })).status, 204);
    await h.settle();
    assert.equal((await h.call('GET', `annotations(${NOTE})?$select=documentbody`)).json.documentbody, replacement);
    if (mode.storage) assert.deepEqual(await annotationKeys(h), [`annotations/${NOTE}/2`]);
    assert.equal((await h.call('PATCH', `annotations(${NOTE})`, { documentbody: null })).status, 204);
    await h.settle();
    assert.equal((await h.call('GET', `annotations(${NOTE})?$select=documentbody`)).json.documentbody, null);
    assert.deepEqual(await annotationKeys(h), []);
    assert.equal((await h.call('PATCH', `annotations(${NOTE})`, { documentbody: BODY })).status, 204);
    assert.equal((await h.call('DELETE', `annotations(${NOTE})`)).status, 204);
    await h.settle();
    assert.deepEqual(await annotationKeys(h), []);
  });

  test(`block-committed notes and attachments store their bytes once and download unchanged ${mode.label}`, async (t) => {
    const h = await routingApi(t, { storage: mode.storage });
    const blocks = async (kind, chunks, commit) => {
      const init = await h.call('POST', `Initialize${kind}BlocksUpload`, { Target: widgetRef });
      const token = init.json.FileContinuationToken,
        ids = chunks.map((_, i) => b64(`block-${i}`));
      for (const [i, chunk] of chunks.entries())
        await h.call('POST', 'UploadBlock', { BlockId: ids[i], BlockData: b64(chunk), FileContinuationToken: token });
      return h.call('POST', `Commit${kind}BlocksUpload`, {
        Target: widgetRef,
        BlockList: ids,
        FileContinuationToken: token,
        ...commit,
      });
    };
    const committedNote = await blocks('Annotation', ['hello ', 'notes'], { FileName: 'notes.txt' });
    assert.equal(committedNote.status, 200, JSON.stringify(committedNote.json));
    const attachment = await blocks('Attachment', ['attached ', 'bytes'], { FileName: 'attached.txt' });
    assert.equal(attachment.status, 200, JSON.stringify(attachment.json));
    const noteId = committedNote.json.AnnotationId,
      attachmentId = attachment.json.ActivityMimeAttachmentId;
    assert.equal(
      (await h.call('GET', `annotations(${noteId})?$select=documentbody`)).json.documentbody,
      b64('hello notes'),
    );
    assert.equal(
      (await h.call('GET', `activitymimeattachments(${attachmentId})?$select=body,filename`)).json.body,
      b64('attached bytes'),
    );
    const stored = row(h, 'activitymimeattachment', attachmentId);
    if (mode.storage) {
      assert.equal(stored.body, null);
      assert.equal(stored.__blobkey, `annotations/${attachmentId}/1`);
    } else assert.equal(stored.body, b64('attached bytes'));

    const target = {
      '@odata.type': 'Microsoft.Dynamics.CRM.activitymimeattachment',
      activitymimeattachmentid: attachmentId,
    };
    const init = await h.call('POST', 'InitializeAttachmentBlocksDownload', { Target: target });
    assert.equal(init.json.FileSizeInBytes, 14);
    const block = await h.call('POST', 'DownloadBlock', {
      Offset: 9,
      BlockLength: 5,
      FileContinuationToken: init.json.FileContinuationToken,
    });
    assert.equal(Buffer.from(block.json.Data, 'base64').toString(), 'bytes');
    const args = encodeURIComponent(JSON.stringify({ '@odata.id': `annotations(${noteId})` }));
    const mint = await h.call('GET', `GetFileSasUrl(Target=@t,FileAttributeName='')?@t=${args}`);
    assert.equal(mint.status, 200, JSON.stringify(mint.json));
    assert.equal(mint.json.Result.FileSizeInBytes, 11);
    const download = await fetch(mint.json.Result.SasUrl);
    assert.equal(await download.text(), 'hello notes');

    assert.equal((await h.call('DELETE', `activitymimeattachments(${attachmentId})`)).status, 204);
    await h.settle();
    if (mode.storage) assert.deepEqual(await annotationKeys(h), [`annotations/${noteId}/1`]);
  });
}

// A release flush deletes only the object it judged dead; bytes put again under the same key after the check stay.
test('a note re-created under the same id while the release flush is between its check and its delete keeps its new body', async (t) => {
  const h = await routingApi(t);
  assert.equal((await h.call('POST', 'annotations', note())).status, 204);
  const remove = h.provider.delete;
  let reached, gate;
  const deletes = [];
  const atDelete = new Promise((resolve) => {
    reached = resolve;
  });
  const opened = new Promise((resolve) => {
    gate = resolve;
  });
  h.provider.delete = async (key, options) => {
    deletes.push([key, options?.ifMatch]);
    reached();
    await opened;
    return remove(key, options);
  };
  assert.equal((await h.call('DELETE', `annotations(${NOTE})`)).status, 204);
  await atDelete;
  const NEW_BODY = b64('the re-created note body');
  assert.equal((await h.call('POST', 'annotations', { ...note(), documentbody: NEW_BODY })).status, 204);
  gate();
  await h.settle();
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0][0], `annotations/${NOTE}/1`);
  assert.ok(deletes[0][1], 'the delete is conditional on the ETag read in the liveness check');
  const read = await h.call('GET', `annotations(${NOTE})?$select=documentbody`);
  assert.equal(read.json.documentbody, NEW_BODY);
});

const providerFailure = () =>
  Object.assign(new Error('connection refused: Endpoint=invented.invalid;SharedAccessKey=INVENTED-KEY'), {
    code: 'ProviderUnavailable',
  });
// A storage failure answers 5xx and names the storage provider, and the answer carries no provider or path detail.
const assertStorageFailure = (h, res) => {
  assert.ok(res.status >= 500 && res.status < 600, `status ${res.status}`);
  const text = res.buffer.toString('utf8');
  assert.match(text, /storage provider/);
  for (const leak of ['INVENTED-KEY', 'Endpoint=', h.root]) assert.equal(text.includes(leak), false);
};
const assertNoNote = async (h) => {
  assert.equal(row(h, 'annotation', NOTE), undefined);
  assert.equal((await h.call('GET', `annotations(${NOTE})`)).status, 404);
  assert.deepEqual(await annotationKeys(h), []);
};

test('a note whose provider put fails at once answers a storage failure and leaves no row or key', async (t) => {
  const h = await routingApi(t);
  h.provider.put = async () => {
    throw providerFailure();
  };
  assertStorageFailure(h, await h.call('POST', 'annotations', note()));
  await assertNoNote(h);
});

test('a note whose provider put fails in flight answers a storage failure and leaves no row or key', async (t) => {
  const h = await routingApi(t);
  let reached, gate;
  const atPut = new Promise((resolve) => {
    reached = resolve;
  });
  const opened = new Promise((resolve) => {
    gate = resolve;
  });
  h.provider.put = async () => {
    reached();
    await opened;
    throw providerFailure();
  };
  const write = h.call('POST', 'annotations', note());
  await atPut;
  gate();
  assertStorageFailure(h, await write);
  await assertNoNote(h);
});

// The synchronous SDK drive (IOrganizationService Create) cannot wait for a provider put, so its body stays inline in the row
// until the put has succeeded; the move to the key is a deferred effect that settle waits for.
const sdkCreateNote = (h, body) => {
  const user = h.store.tableRows('systemuser')[0];
  const sdk = localOrganizationService(h.store, {
    userId: user.systemuserid,
    evidence: 'invented test grants',
    grants: [{ entity: 'annotation', operations: ['create', 'read'] }],
  });
  return h.store.transact(() => sdk.create('annotation', note(NOTE, body)));
};

test('a note created through the synchronous SDK service keeps its inline body when its provider put rejects', async (t) => {
  const h = await routingApi(t);
  h.provider.put = async () => {
    throw providerFailure();
  };
  await sdkCreateNote(h);
  await h.settle();
  const stored = row(h, 'annotation', NOTE);
  assert.ok(stored, 'the row is committed with the call');
  assert.equal(stored.documentbody, BODY);
  assert.ok(!stored.__blobkey, 'no blob key is stored for bytes that were never written');
  assert.deepEqual(await annotationKeys(h), []);
  assert.equal((await h.call('GET', `annotations(${NOTE})?$select=documentbody`)).json.documentbody, BODY);
  assert.ok(h.diagnostics.some((d) => d.code === 'STORAGE_WRITE_FAILED'));
});

test('a note created through the synchronous SDK service moves its body to the provider once the put succeeded', async (t) => {
  const h = await routingApi(t);
  await sdkCreateNote(h);
  await h.settle();
  const stored = row(h, 'annotation', NOTE);
  assert.equal(stored.documentbody, null);
  assert.equal(stored.__blobkey, `annotations/${NOTE}/1`);
  assert.deepEqual(await annotationKeys(h), [`annotations/${NOTE}/1`]);
  assert.equal((await h.call('GET', `annotations(${NOTE})?$select=documentbody`)).json.documentbody, BODY);
});

// A later beforeWrite hook refuses the write after the routing hook registered its put and its pending move.
test('a synchronous SDK write that fails after its beforeWrite leaves no pending move', async (t) => {
  const h = await routingApi(t);
  let pendingAtRefusal = null;
  h.api.recordHooks.add('beforeWrite', (c, mapping) => {
    if (mapping.logicalName !== 'annotation') return;
    pendingAtRefusal = h.api.storageRouting.pendingSyncWrites();
    throw new Error('invented refusal after the routing hook');
  });
  await assert.rejects(sdkCreateNote(h), /invented refusal after the routing hook/);
  assert.equal(pendingAtRefusal, 1, 'the routing hook had registered its pending move');
  await h.settle();
  assert.equal(h.api.storageRouting.pendingSyncWrites(), 0);
  assert.equal(row(h, 'annotation', NOTE), undefined);
  assert.deepEqual(await annotationKeys(h), [], 'the bytes of the refused write are released');
});

// A second create of a stored id is refused by the store; its body never reaches the stored note's key.
for (const via of ['the Web API', 'the synchronous SDK service']) {
  test(`a refused create of a stored note id through ${via} keeps the stored body`, async (t) => {
    const h = await routingApi(t);
    const other = b64('another invented body '.repeat(40));
    if (via === 'the Web API') {
      assert.equal((await h.call('POST', 'annotations', note())).status, 204);
      assert.equal((await h.call('POST', 'annotations', note(NOTE, other))).status, 412);
    } else {
      await sdkCreateNote(h);
      await h.settle();
      await assert.rejects(sdkCreateNote(h, other));
    }
    await h.settle();
    assert.equal(h.api.storageRouting.pendingSyncWrites(), 0);
    assert.deepEqual(await annotationKeys(h), [`annotations/${NOTE}/1`]);
    const stored = await h.provider.get(`annotations/${NOTE}/1`);
    const chunks = [];
    for await (const chunk of stored.body) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString('base64'), BODY);
    assert.equal((await h.call('GET', `annotations(${NOTE})?$select=documentbody`)).json.documentbody, BODY);
  });
}

test('a note whose provider put succeeds stores its key and reads the body back', async (t) => {
  const h = await routingApi(t);
  assert.equal((await h.call('POST', 'annotations', note())).status, 204);
  assert.equal(row(h, 'annotation', NOTE).__blobkey, `annotations/${NOTE}/1`);
  assert.deepEqual(await annotationKeys(h), [`annotations/${NOTE}/1`]);
  assert.equal((await h.call('GET', `annotations(${NOTE})?$select=documentbody`)).json.documentbody, BODY);
});

// Only the routing module's own incremental transaction (its release check) is counted.
test('a committed note create runs no release check for its own key', async (t) => {
  const h = await routingApi(t);
  const transact = h.store.transact;
  let checks = 0;
  h.store.transact = function (fn, options, ...rest) {
    if (options?.incremental && new Error().stack.includes('dataverse-storage-routing.mjs')) checks += 1;
    return transact.call(this, fn, options, ...rest);
  };
  assert.equal((await h.call('POST', 'annotations', note())).status, 204);
  await h.settle();
  h.store.transact = transact;
  assert.equal(checks, 0);
  assert.deepEqual(await annotationKeys(h), [`annotations/${NOTE}/1`]);
});

// The project hook builds the note id map once per request, not once per listed row.
// Only the routing module's reads are counted: the records layer has its own per-row lookups.
test('listing several notes with documentbody reads the annotation table once in the routing project hook', async (t) => {
  const callsFor = async (count) => {
    const h = await routingApi(t);
    for (let i = 0; i < count; i += 1) {
      const id = `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`;
      assert.equal((await h.call('POST', 'annotations', note(id))).status, 204);
    }
    const tableRows = h.store.tableRows;
    let calls = 0;
    h.store.tableRows = function (logical, ...rest) {
      if (logical === 'annotation' && new Error().stack.includes('dataverse-storage-routing.mjs')) calls += 1;
      return tableRows.call(this, logical, ...rest);
    };
    const list = await h.call('GET', 'annotations?$select=documentbody');
    h.store.tableRows = tableRows;
    assert.equal(list.json.value.length, count);
    assert.ok(list.json.value.every((row) => row.documentbody === BODY));
    return calls;
  };
  assert.equal(await callsFor(10), 1);
});
