// File and image column bytes through the storage routing extension, with a local-disk storage router and without one:
// upload, download, ranges, blocks, SAS, delete-after-commit and the orphan sweep.
// @test-kind contract: Paqvilo's own storage routing design; a rejected provider put fails the file or image write as a note's does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MODES, WIDGET, b64, routingApi, tempRoot, widgetRef } from './storage-routing-fixture.mjs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7]);
const CONTENT = Buffer.from('invented file bytes for the routing test '.repeat(64));
const widget = `fx_widgets(${WIDGET})`;
const upload = (h, bytes = CONTENT) =>
  h.call('PATCH', `${widget}/fx_doc`, bytes, {
    'content-type': 'application/octet-stream',
    'x-ms-file-name': 'invented.txt',
  });
const fileEntries = (store) =>
  Object.values(store.state.dataverse?.files ?? {}).filter((entry) => entry.entity === 'fx_widget');
const fileKeys = async (h) => (await h.blobKeys()).filter((key) => key.startsWith('files/'));

for (const mode of MODES) {
  test(`file column upload, download, range and image column read back unchanged ${mode.label}`, async (t) => {
    const root = await tempRoot(t);
    const file = path.join(root, 'state.json');
    const h = await routingApi(t, { storage: mode.storage, root, file });
    assert.equal((await upload(h)).status, 204);
    const full = await h.call('GET', `${widget}/fx_doc/$value`);
    assert.equal(full.status, 200);
    assert.deepEqual(full.buffer, CONTENT);
    assert.equal(full.headers.get('x-ms-file-size'), String(CONTENT.length));
    const ranged = await h.call('GET', `${widget}/fx_doc/$value`, undefined, { range: 'bytes=5-20' });
    assert.equal(ranged.status, 206);
    assert.deepEqual(ranged.buffer, CONTENT.subarray(5, 21));
    assert.equal(ranged.headers.get('content-range'), `bytes 5-20/${CONTENT.length}`);
    assert.equal(
      (await h.call('GET', `${widget}/fx_doc/$value`, undefined, { range: `bytes=${CONTENT.length}-` })).status,
      416,
    );

    assert.equal((await h.call('PATCH', widget, { fx_photo: PNG.toString('base64') })).status, 204);
    const photo = await h.call('GET', `${widget}?$select=fx_photo`);
    assert.equal(photo.json.fx_photo, PNG.toString('base64'));

    const [entry] = fileEntries(h.store).filter((e) => e.column === 'fx_doc');
    assert.equal(entry.size, CONTENT.length);
    const saved = await fs.readFile(file, 'utf8');
    if (mode.storage) {
      assert.equal(entry.data, undefined);
      assert.match(entry.key, /^files\/[0-9a-f-]{36}$/);
      assert.equal(
        saved.includes(CONTENT.toString('base64').slice(0, 40)),
        false,
        'the saved state holds no file base64',
      );
      assert.equal(saved.includes(PNG.toString('base64')), false, 'the saved state holds no image base64');
      assert.equal((await fileKeys(h)).length, 2);
    } else {
      assert.equal(entry.data, CONTENT.toString('base64'));
      assert.equal(saved.includes(CONTENT.toString('base64').slice(0, 40)), true);
    }
  });

  test(`block upload commits once and replacing a file releases the old bytes after commit ${mode.label}`, async (t) => {
    const h = await routingApi(t, { storage: mode.storage });
    const init = await h.call('POST', 'InitializeFileBlocksUpload', {
      Target: widgetRef,
      FileAttributeName: 'fx_doc',
      FileName: 'blocks.txt',
    });
    assert.equal(init.status, 200, JSON.stringify(init.json));
    const token = init.json.FileContinuationToken,
      ids = [b64('block-0'), b64('block-1')];
    for (const [i, part] of ['first half, ', 'second half'].entries()) {
      assert.equal(
        (await h.call('POST', 'UploadBlock', { BlockId: ids[i], BlockData: b64(part), FileContinuationToken: token }))
          .status,
        204,
      );
    }
    const commit = await h.call('POST', 'CommitFileBlocksUpload', {
      FileName: 'blocks.txt',
      MimeType: 'text/plain',
      BlockList: ids,
      FileContinuationToken: token,
    });
    assert.equal(commit.status, 200, JSON.stringify(commit.json));
    assert.equal(commit.json.FileSizeInBytes, 23);
    assert.equal((await h.call('GET', `${widget}/fx_doc/$value`)).buffer.toString(), 'first half, second half');
    const download = await h.call('POST', 'InitializeFileBlocksDownload', {
      Target: widgetRef,
      FileAttributeName: 'fx_doc',
    });
    const block = await h.call('POST', 'DownloadBlock', {
      Offset: 6,
      BlockLength: 4,
      FileContinuationToken: download.json.FileContinuationToken,
    });
    assert.equal(Buffer.from(block.json.Data, 'base64').toString(), 'half');

    assert.equal((await upload(h, Buffer.from('replacement'))).status, 204);
    await h.settle();
    assert.equal(fileEntries(h.store).length, 1);
    if (mode.storage) assert.deepEqual(await fileKeys(h), [fileEntries(h.store)[0].key]);
  });

  test(`chunked and SAS uploads land as one file ${mode.label}`, async (t) => {
    const h = await routingApi(t, { storage: mode.storage });
    const start = await h.call('PATCH', `${widget}/fx_doc`, Buffer.alloc(0), {
      'x-ms-transfer-mode': 'chunked',
      'x-ms-file-name': 'chunked.txt',
    });
    assert.equal(start.status, 200);
    const location = new URL(start.headers.get('location'));
    const parts = [CONTENT.subarray(0, 100), CONTENT.subarray(100)];
    let at = 0;
    for (const part of parts) {
      const sent = await h.call(
        'PATCH',
        `${location.pathname.replace(/^\/api\/data\/v9\.2\//, '')}${location.search}`,
        part,
        {
          'content-type': 'application/octet-stream',
          'content-range': `bytes ${at}-${at + part.length - 1}/${CONTENT.length}`,
        },
      );
      assert.ok([204, 206].includes(sent.status), String(sent.status));
      at += part.length;
    }
    assert.deepEqual((await h.call('GET', `${widget}/fx_doc/$value`)).buffer, CONTENT);

    const args = encodeURIComponent(JSON.stringify({ '@odata.id': widget }));
    const mint = await h.call(
      'GET',
      `GetFileSasUrlForUpload(Target=@t,FileAttributeName='fx_doc',FileName='sas.txt')?@t=${args}`,
    );
    assert.equal(mint.status, 200, JSON.stringify(mint.json));
    const put = await fetch(mint.json.Result.SasUrl, {
      method: 'PUT',
      body: Buffer.from('uploaded through a SAS URL'),
    });
    assert.equal(put.status, 201);
    const commit = await h.call('POST', 'CommitFileBlocksUpload', {
      FileName: 'sas.txt',
      MimeType: 'text/plain',
      BlockList: [b64('sas')],
      FileContinuationToken: mint.json.Result.FileContinuationToken,
    });
    assert.equal(commit.status, 200, JSON.stringify(commit.json));
    assert.equal((await h.call('GET', `${widget}/fx_doc/$value`)).buffer.toString(), 'uploaded through a SAS URL');
    await h.settle();
    assert.equal(fileEntries(h.store).length, 1);
    if (mode.storage) assert.deepEqual(await fileKeys(h), [fileEntries(h.store)[0].key]);
  });

  test(`a SAS URL downloads the file anonymously ${mode.label}`, async (t) => {
    const h = await routingApi(t, { storage: mode.storage });
    await upload(h);
    const args = encodeURIComponent(JSON.stringify({ '@odata.id': widget }));
    const mint = await h.call('GET', `GetFileSasUrl(Target=@t,FileAttributeName='fx_doc')?@t=${args}`);
    assert.equal(mint.status, 200, JSON.stringify(mint.json));
    const sas = new URL(mint.json.Result.SasUrl);
    assert.equal(sas.pathname.startsWith(mode.storage ? '/_sas/storage/' : '/_sas/files/'), true);
    const download = await fetch(sas);
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), CONTENT);
    assert.match(download.headers.get('content-disposition'), /filename="invented\.txt"/);
    sas.searchParams.set('sig', 'tampered');
    assert.equal((await fetch(sas)).status, 403);
  });

  test(`deleting a record removes its file entry and bytes after commit ${mode.label}`, async (t) => {
    const h = await routingApi(t, { storage: mode.storage });
    await upload(h);
    assert.equal((await h.call('PATCH', widget, { fx_photo: PNG.toString('base64') })).status, 204);
    assert.equal(fileEntries(h.store).length, 2);
    assert.equal((await h.call('DELETE', widget)).status, 204);
    await h.settle();
    assert.deepEqual(fileEntries(h.store), []);
    assert.deepEqual(await fileKeys(h), []);
  });

  test(`a failed write after the put leaves no referenced bytes and the sweep removes the orphan ${mode.label}`, async (t) => {
    const h = await routingApi(t, { storage: mode.storage });
    const save = h.store.save.bind(h.store);
    h.store.save = async () => {
      h.store.save = save;
      throw Object.assign(new Error('Invented disk failure'), { status: 500 });
    };
    const failed = await upload(h);
    assert.notEqual(failed.status, 204);
    assert.deepEqual(fileEntries(h.store), []);
    await h.settle();
    if (!mode.storage) return;
    assert.equal((await fileKeys(h)).length, 1, 'the put landed before the transaction failed');
    const swept = await h.server.organization.api.storageRouting.sweep();
    assert.equal(swept.removed, 1);
    assert.deepEqual(await fileKeys(h), []);
    assert.ok(h.diagnostics.some((d) => d.code === 'STORAGE_SWEPT'));
  });
}

const providerFailure = () =>
  Object.assign(new Error('connection refused: Endpoint=invented.invalid;SharedAccessKey=INVENTED-KEY'), {
    code: 'ProviderUnavailable',
  });
const rejectingPuts = (h) => {
  h.provider.put = async () => {
    throw providerFailure();
  };
};
// Rejects the nth provider put from now on; the puts before it reach the provider.
const failNthPut = (h, n) => {
  const put = h.provider.put;
  let calls = 0;
  h.provider.put = (...args) => {
    calls += 1;
    if (calls === n) return Promise.reject(providerFailure());
    return put(...args);
  };
};
// The note path's answer: 503 with the same envelope code and message, and no provider, key or path detail.
const assertWriteFailed = (h, res) => {
  const text = res.buffer.toString('utf8');
  assert.equal(res.status, 503, text);
  assert.equal(res.json.error.code, '0x80040216', text);
  assert.equal(
    res.json.error.message,
    'The body could not be written to its storage provider; the write was rolled back.',
  );
  for (const leak of ['INVENTED-KEY', 'Endpoint=', h.root]) assert.equal(text.includes(leak), false);
};
// Starts a chunked upload of CONTENT in two ranges and answers the second, last range.
async function chunkedUpload(h) {
  const start = await h.call('PATCH', `${widget}/fx_doc`, Buffer.alloc(0), {
    'x-ms-transfer-mode': 'chunked',
    'x-ms-file-name': 'chunked.txt',
  });
  assert.equal(start.status, 200);
  const location = new URL(start.headers.get('location'));
  const target = `${location.pathname.replace(/^\/api\/data\/v9\.2\//, '')}${location.search}`;
  const range = (from, to) =>
    h.call('PATCH', target, CONTENT.subarray(from, to), {
      'content-type': 'application/octet-stream',
      'content-range': `bytes ${from}-${to - 1}/${CONTENT.length}`,
    });
  assert.equal((await range(0, 100)).status, 206);
  return range(100, CONTENT.length);
}

test('a file upload whose provider put rejects answers the write failure and keeps the stored file', async (t) => {
  const h = await routingApi(t);
  assert.equal((await upload(h)).status, 204);
  rejectingPuts(h);
  assertWriteFailed(h, await upload(h, Buffer.from('replacement bytes')));
  await h.settle();
  assert.deepEqual((await h.call('GET', `${widget}/fx_doc/$value`)).buffer, CONTENT);
  assert.equal(fileEntries(h.store).length, 1);
});

test('an image write whose provider put rejects answers the write failure and leaves the column empty', async (t) => {
  const h = await routingApi(t);
  rejectingPuts(h);
  assertWriteFailed(h, await h.call('PATCH', widget, { fx_photo: PNG.toString('base64') }));
  await h.settle();
  assert.equal((await h.call('GET', `${widget}?$select=fx_photo`)).json.fx_photo, null);
  assert.deepEqual(fileEntries(h.store), []);
});

for (const [label, arm] of [
  ['put', (h) => failNthPut(h, 2)],
  [
    'commit',
    (h) => {
      h.provider.commit = async () => {
        throw providerFailure();
      };
    },
  ],
]) {
  test(`the last chunk of a chunked upload whose provider ${label} rejects answers the write failure and keeps the stored file`, async (t) => {
    const h = await routingApi(t);
    assert.equal((await upload(h)).status, 204);
    arm(h);
    assertWriteFailed(h, await chunkedUpload(h));
    await h.settle();
    assert.deepEqual((await h.call('GET', `${widget}/fx_doc/$value`)).buffer, CONTENT);
    assert.equal(fileEntries(h.store).length, 1);
  });
}

const blockInit = async (h) => {
  const init = await h.call('POST', 'InitializeFileBlocksUpload', {
    Target: widgetRef,
    FileAttributeName: 'fx_doc',
    FileName: 'blocks.txt',
  });
  assert.equal(init.status, 200, JSON.stringify(init.json));
  return init.json.FileContinuationToken;
};
const stageBlock = (h, token) =>
  h.call('POST', 'UploadBlock', {
    BlockId: b64('block-0'),
    BlockData: b64('block bytes'),
    FileContinuationToken: token,
  });

test('a block upload whose provider put or commit rejects answers the write failure and keeps the stored file', async (t) => {
  const h = await routingApi(t);
  assert.equal((await upload(h)).status, 204);
  const put = h.provider.put;
  rejectingPuts(h);
  assertWriteFailed(h, await stageBlock(h, await blockInit(h)));
  h.provider.put = put;
  const token = await blockInit(h);
  assert.equal((await stageBlock(h, token)).status, 204);
  h.provider.commit = async () => {
    throw providerFailure();
  };
  assertWriteFailed(
    h,
    await h.call('POST', 'CommitFileBlocksUpload', {
      FileName: 'blocks.txt',
      MimeType: 'text/plain',
      BlockList: [b64('block-0')],
      FileContinuationToken: token,
    }),
  );
  await h.settle();
  assert.deepEqual((await h.call('GET', `${widget}/fx_doc/$value`)).buffer, CONTENT);
  assert.equal(fileEntries(h.store).length, 1);
});

test('a failed file or image write records a STORAGE_WRITE_FAILED diagnostic for its key', async (t) => {
  const h = await routingApi(t);
  rejectingPuts(h);
  assertWriteFailed(h, await upload(h));
  assertWriteFailed(h, await h.call('PATCH', widget, { fx_photo: PNG.toString('base64') }));
  const failures = h.diagnostics.filter((d) => d.code === 'STORAGE_WRITE_FAILED');
  assert.equal(failures.length, 2);
  assert.deepEqual(
    failures.map((d) => d.entity),
    ['fx_widget', 'fx_widget'],
  );
  assert.ok(failures.every((d) => /^files\/[0-9a-f-]{36}$/.test(d.key)));
});

// Each key follows its own route; an unserved route keeps its bytes in state as a runtime without storage does.
const noteBlocks = async (h, text) => {
  const init = await h.call('POST', 'InitializeAnnotationBlocksUpload', { Target: widgetRef });
  assert.equal(init.status, 200, JSON.stringify(init.json));
  const token = init.json.FileContinuationToken,
    id = b64('note-block-0');
  assert.equal(
    (await h.call('POST', 'UploadBlock', { BlockId: id, BlockData: b64(text), FileContinuationToken: token })).status,
    204,
  );
  const commit = await h.call('POST', 'CommitAnnotationBlocksUpload', {
    Target: { filename: 'n.txt', mimetype: 'text/plain' },
    BlockList: [id],
    FileContinuationToken: token,
  });
  assert.equal(commit.status, 200, JSON.stringify(commit.json));
  return h.store.tableRows('annotation').find((row) => row.annotationid === commit.json.AnnotationId);
};

test('file bytes stay in state when only the annotations route is served; note blocks still reach the provider', async (t) => {
  const h = await routingApi(t, { routes: { dataverseFiles: 'gone', annotations: 'local' } });
  assert.equal((await upload(h)).status, 204);
  const [entry] = fileEntries(h.store);
  assert.equal(entry.data, CONTENT.toString('base64'));
  assert.equal(entry.key, undefined);
  assert.deepEqual((await h.call('GET', `${widget}/fx_doc/$value`)).buffer, CONTENT);
  const note = await noteBlocks(h, 'routed note bytes');
  assert.equal(note.documentbody, null);
  assert.match(note.__blobkey, /^annotations\//);
  assert.deepEqual(await h.blobKeys(), [note.__blobkey]);
  const read = await h.call('GET', `annotations(${note.annotationid})?$select=documentbody`);
  assert.equal(read.json.documentbody, b64('routed note bytes'));
});

test('note blocks stay inline when only the dataverseFiles route is served; file bytes still reach the provider', async (t) => {
  const h = await routingApi(t, { routes: { dataverseFiles: 'local', annotations: 'gone' } });
  assert.equal((await upload(h)).status, 204);
  const [entry] = fileEntries(h.store);
  assert.equal(entry.data, undefined);
  assert.match(entry.key, /^files\//);
  const note = await noteBlocks(h, 'inline note bytes');
  assert.equal(note.documentbody, b64('inline note bytes'));
  assert.equal(note.__blobkey, undefined);
  assert.deepEqual(await h.blobKeys(), [entry.key]);
});

// Bytes put before their row commits are in flight; a sweep in between keeps them.
test("a sweep between an upload's put and its row write keeps the uploaded bytes", async (t) => {
  const h = await routingApi(t);
  const put = h.provider.put;
  let swept = null;
  h.provider.put = async (key, ...rest) => {
    const answer = await put(key, ...rest);
    if (key.startsWith('files/') && !swept) swept = await h.api.storageRouting.sweep();
    return answer;
  };
  assert.equal((await upload(h)).status, 204);
  assert.deepEqual([swept.removed, swept.entries], [0, 0], 'the in-flight object was not swept');
  const read = await h.call('GET', `${widget}/fx_doc/$value`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.buffer, CONTENT);
});

test('the routing sweep runs the outbox sweep and reports its counts', async (t) => {
  const h = await routingApi(t);
  let calls = 0;
  h.api.providers = {
    ...h.api.providers,
    outbox: {
      sweep: async () => {
        calls += 1;
        return { deleted: 2, pending: 1 };
      },
    },
  };
  const result = await h.api.storageRouting.sweep();
  assert.equal(calls, 1);
  assert.deepEqual(result.outbox, { deleted: 2, pending: 1 });
});

test('closing the API drains an accepted blob delete before its state directory is removed', async () => {
  const hooks = [],
    fixture = await routingApi({ after: (hook) => hooks.push(hook) });
  const remove = fs.rm,
    objectPrefix = path.join(fixture.root, 'blobs', 'objects') + path.sep;
  let enter,
    release,
    removed = false,
    cleanup;
  const entered = new Promise((resolve) => {
      enter = resolve;
    }),
    gate = new Promise((resolve) => {
      release = resolve;
    });
  // Hold the provider's object removal so the directory cleanup has to wait for it.
  fs.rm = async (target, options) => {
    if (String(target).startsWith(objectPrefix)) {
      enter();
      await gate;
    }
    if (target === fixture.root) removed = true;
    return remove(target, options);
  };
  try {
    assert.equal((await upload(fixture)).status, 204);
    assert.equal((await fixture.call('DELETE', `${widget}/fx_doc`)).status, 204);
    await entered;
    cleanup = (async () => {
      for (const hook of hooks) await hook();
    })();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(removed, false, 'directory cleanup must await the accepted release');
    release();
    await cleanup;
    assert.equal(removed, true);
    await assert.rejects(fs.stat(fixture.root), { code: 'ENOENT' });
  } finally {
    release();
    await cleanup?.catch(() => {});
    fs.rm = remove;
    await fixture.close();
    await remove(fixture.root, { recursive: true, force: true });
  }
});
