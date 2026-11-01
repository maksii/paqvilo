// With file bytes stored through the storage router, an unrelated row update costs what it does with no files: the
// bytes are neither cloned with the state's non-table sections on every write nor read back from the provider.
// Both mechanisms are asserted directly (state size and provider reads) rather than through machine-dependent
// wall-clock ratios. Only the routed runtime is covered: without a router the bytes stay in state by design.
import test from 'node:test';
import assert from 'node:assert/strict';
import { routingApi } from './storage-routing-fixture.mjs';

const OTHER = '77777777-7777-4777-8777-7777777777e1';
const FILES = 16,
  FILE_BYTES = 256 * 1024; // 4 MiB in all: 64 times the state-growth bound below
const STATE_GROWTH_BOUND = 64 * 1024;

test('an unrelated row update neither carries nor reads routed file bytes', async (t) => {
  const h = await routingApi(t, {
    storage: true,
    before: (store) => {
      for (let i = 0; i < FILES; i++) {
        store.state.tables.fx_widget.push({
          fx_widgetid: `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`,
          fx_name: `Holder ${i}`,
        });
      }
      store.state.tables.fx_widget.push({ fx_widgetid: OTHER, fx_name: 'Unrelated' });
    },
  });
  const stateBefore = JSON.stringify(h.store.state).length;
  const block = Buffer.alloc(FILE_BYTES, 7);
  for (let i = 0; i < FILES; i++) {
    const response = await h.call(
      'PATCH',
      `fx_widgets(77777777-7777-4777-8777-${String(i).padStart(12, '0')})/fx_doc`,
      block,
      { 'content-type': 'application/octet-stream', 'x-ms-file-name': `holder-${i}.bin` },
    );
    assert.equal(response.status, 204);
  }
  await h.settle();
  assert.equal(Object.keys(h.store.state.dataverse.files).length, FILES);
  assert.equal((await h.blobKeys()).length, FILES, 'every file body is stored by the provider');
  assert.ok(
    JSON.stringify(h.store.state).length - stateBefore < STATE_GROWTH_BOUND,
    'state grew by file metadata, not by the file bytes',
  );
  const reads = [];
  for (const operation of ['get', 'head', 'list']) {
    const original = h.provider[operation].bind(h.provider);
    h.provider[operation] = (...args) => {
      reads.push(operation);
      return original(...args);
    };
  }
  for (let i = 0; i < 3; i++) {
    const response = await h.call('PATCH', `fx_widgets(${OTHER})`, { fx_name: `Unrelated ${i}` });
    assert.equal(response.status, 204);
  }
  await h.settle();
  assert.deepEqual(reads, [], 'an unrelated update does not touch stored file bodies');
  assert.equal(h.store.tableRows('fx_widget').at(-1).fx_name, 'Unrelated 2');
  // The spy observes the router's provider calls: downloading a routed file reads its body.
  const download = await h.call(
    'GET',
    `fx_widgets(77777777-7777-4777-8777-${String(0).padStart(12, '0')})/fx_doc/$value`,
  );
  assert.equal(download.status, 200);
  assert.equal(download.buffer.length, FILE_BYTES);
  assert.ok(reads.includes('get'), reads.join(','));
});
