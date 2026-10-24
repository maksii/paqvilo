// One attachment size rule: a /_sim MaxUploadFileSize override applies to record writes and to the block messages
// alike, counted in Base64 characters on both.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentApi, b64 } from './attachment-api-fixture.mjs';

// 16 Base64 characters: 12 raw bytes fit, 13 raw bytes (20 characters) do not.
const limit16 = (store) => {
  store.state.simulator = { ...store.state.simulator, platformOverrides: { MaxUploadFileSize: 16 } };
};
const TOO_BIG = 'Attachment file size is too big.';

test('a /_sim MaxUploadFileSize override applies equally to the record path and the block path', async (t) => {
  const h = await attachmentApi(t, { before: limit16 });
  const fits = 'x'.repeat(12),
    over = 'x'.repeat(13);

  const recordOver = await h.send('annotations', { filename: 'a.txt', documentbody: b64(over) });
  assert.equal(recordOver.status, 400);
  assert.equal(recordOver.json.error.message, TOO_BIG);
  assert.equal(recordOver.json.error.code, '0x80044a02');
  assert.equal((await h.send('annotations', { filename: 'a.txt', documentbody: b64(fits) })).status, 204);

  for (const kind of ['Annotation', 'Attachment']) {
    const blockOver = await h.blocks(kind, [over], { FileName: 'a.txt' });
    assert.equal(blockOver.status, 400, kind);
    assert.deepEqual(blockOver.json.error, recordOver.json.error, kind);
    const blockFits = await h.blocks(kind, [fits.slice(0, 6), fits.slice(6)], { FileName: 'a.txt' });
    assert.equal(blockFits.status, 200, `${kind}: ${JSON.stringify(blockFits.json)}`);
    assert.equal(blockFits.json.FileSizeInBytes, 12);
  }
});
