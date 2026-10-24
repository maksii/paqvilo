// A state file written without storage routing (inline file data, note documentbody, attachment body) migrates to the storage
// provider once on load, is idempotent on the next load, reports one STORAGE_MIGRATED diagnostic with counts, and Web API reads
// answer as before. Without a router the same file loads unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MODES, WIDGET, b64, routingApi, tempRoot, widgetRef } from './storage-routing-fixture.mjs';

const NOTE = '77777777-7777-4777-8777-7777777777d1';
const FILE_BYTES = Buffer.from('legacy inline file bytes '.repeat(30));
const NOTE_BODY = b64('legacy inline note body '.repeat(30));

async function legacyState(t, root, file) {
  const h = await routingApi(t, { storage: false, root, file });
  await h.call('PATCH', `fx_widgets(${WIDGET})/fx_doc`, FILE_BYTES, {
    'content-type': 'application/octet-stream',
    'x-ms-file-name': 'legacy.txt',
  });
  await h.call('POST', 'annotations', {
    annotationid: NOTE,
    subject: 'Legacy note',
    filename: 'legacy.txt',
    mimetype: 'text/plain',
    documentbody: NOTE_BODY,
  });
  const init = await h.call('POST', 'InitializeAttachmentBlocksUpload', { Target: widgetRef });
  await h.call('POST', 'UploadBlock', {
    BlockId: b64('b0'),
    BlockData: b64('legacy attachment'),
    FileContinuationToken: init.json.FileContinuationToken,
  });
  const attachment = await h.call('POST', 'CommitAttachmentBlocksUpload', {
    Target: widgetRef,
    BlockList: [b64('b0')],
    FileContinuationToken: init.json.FileContinuationToken,
    FileName: 'a.txt',
  });
  await h.close();
  return attachment.json.ActivityMimeAttachmentId;
}

async function reads(h, attachmentId) {
  return {
    file: (await h.call('GET', `fx_widgets(${WIDGET})/fx_doc/$value`)).buffer.toString(),
    note: (await h.call('GET', `annotations(${NOTE})`)).json.documentbody,
    attachment: (await h.call('GET', `activitymimeattachments(${attachmentId})?$select=body`)).json.body,
  };
}
const expected = { file: FILE_BYTES.toString(), note: NOTE_BODY, attachment: b64('legacy attachment') };

for (const mode of MODES) {
  test(`a legacy state file loads ${mode.storage ? 'migrated once and idempotently' : 'unchanged'} ${mode.label}`, async (t) => {
    const root = await tempRoot(t);
    const file = path.join(root, 'state.json');
    const attachmentId = await legacyState(t, root, file);
    assert.equal(
      (await fs.readFile(file, 'utf8')).includes(NOTE_BODY.slice(0, 40)),
      true,
      'the legacy file holds inline bytes',
    );

    const first = await routingApi(t, { storage: mode.storage, root, file });
    assert.deepEqual(await reads(first, attachmentId), expected);
    const migrated = first.diagnostics.filter((d) => d.code === 'STORAGE_MIGRATED');
    const saved = await fs.readFile(file, 'utf8');
    if (!mode.storage) {
      assert.deepEqual(migrated, []);
      assert.equal(saved.includes(NOTE_BODY.slice(0, 40)), true);
      return;
    }
    assert.equal(migrated.length, 1);
    assert.deepEqual(migrated[0].counts, {
      files: 1,
      annotations: 1,
      attachments: 1,
      bytes: FILE_BYTES.length + Buffer.from(NOTE_BODY, 'base64').length + 17,
    });
    assert.equal(saved.includes(NOTE_BODY.slice(0, 40)), false, 'the note body left the state file');
    assert.equal(
      saved.includes(FILE_BYTES.toString('base64').slice(0, 40)),
      false,
      'the file bytes left the state file',
    );
    const keys = await first.blobKeys();
    assert.deepEqual(
      keys.sort(),
      [`annotations/${attachmentId}/1`, `annotations/${NOTE}/1`, keys.find((key) => key.startsWith('files/'))].sort(),
    );
    await first.close();

    const second = await routingApi(t, { storage: true, root, file });
    assert.deepEqual(
      second.diagnostics.filter((d) => d.code === 'STORAGE_MIGRATED'),
      [],
    );
    assert.deepEqual((await second.blobKeys()).sort(), keys.sort());
    assert.deepEqual(await reads(second, attachmentId), expected);
  });
}
