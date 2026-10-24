// With 64 MiB of file bytes stored through the storage router, an unrelated row update costs about what it does with no
// files (bytes are not cloned with the state's non-table sections on every write). Both are measured here.
// Only the routed runtime is measured: without a router the bytes stay in state by design and this cost remains.
import test from 'node:test';
import assert from 'node:assert/strict';
import { routingApi } from './storage-routing-fixture.mjs';

const OTHER = '77777777-7777-4777-8777-7777777777e1';
const FILES = 16,
  FILE_BYTES = 4 * 1024 * 1024; // 64 MiB in all
const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function updateCost(h, rounds = 15) {
  const times = [];
  for (let i = 0; i < rounds; i++) {
    const started = performance.now();
    const response = await h.call('PATCH', `fx_widgets(${OTHER})`, { fx_name: `Unrelated ${i}` });
    times.push(performance.now() - started);
    assert.equal(response.status, 204);
  }
  return median(times);
}

test('an unrelated row update stays within 3x of the no-files baseline with 64 MiB of routed files', async (t) => {
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
  await updateCost(h, 3); // warm-up
  const baseline = await updateCost(h);
  if (baseline > 1000)
    return t.skip(`baseline update took ${Math.round(baseline)} ms; this machine is too slow to compare write costs`);
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
  assert.equal(Object.keys(h.store.state.dataverse.files).length, FILES);
  assert.ok(
    JSON.stringify(h.store.state).length - stateBefore < 64 * 1024,
    'state grew by file metadata, not by the 64 MiB',
  );
  const loaded = await updateCost(h);
  assert.ok(
    loaded <= 3 * baseline + 5,
    `update with files ${loaded.toFixed(1)} ms vs baseline ${baseline.toFixed(1)} ms`,
  );
});
