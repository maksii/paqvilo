import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createOutbox } from '../lib/outbox.mjs';
import { createMemoryStorage } from '../lib/storage-memory.mjs';

const attachment = [{ name: 'a.txt', content: Buffer.from('invented attachment') }];
const message = subject => ({ channel: 'email', to: ['x@example.test'], subject, attachments: attachment });

// A memory provider whose next list() waits until released, then runs `afterList` before answering.
function gated() {
  const storage = createMemoryStorage({ id: 'outbox-test' });
  let gate = null, afterList = null;
  const list = storage.list.bind(storage);
  storage.list = async (prefix, options) => {
    if (gate) { const wait = gate; gate = null; await wait; }
    const page = await list(prefix, options);
    if (afterList) { const run = afterList; afterList = null; await run(); }
    return page;
  };
  return { storage, hold() { let release; gate = new Promise(resolve => { release = resolve; }); return release; }, after(fn) { afterList = fn; } };
}
const bytes = async (storage, key) => { const object = await storage.get(key).catch(() => null); if (!object) return null; const parts = []; for await (const part of object.body) parts.push(part); return Buffer.concat(parts).toString(); };

test('a capture committed while sweep lists keeps its bytes', async () => {
  const { storage, hold } = gated();
  const outbox = createOutbox({ store: await new DataStore({ state: emptyState() }).init(), storage });
  const release = hold();
  const sweeping = outbox.sweep();
  await new Promise(resolve => setImmediate(resolve));
  const entry = await outbox.capture(message('Invented'));
  release();
  assert.deepEqual(await sweeping, { deleted: 0, pending: 0 });
  assert.equal(await bytes(storage, entry.attachments[0].key), 'invented attachment');
});

test('an unreferenced key put again after listing is not deleted (ETag condition)', async () => {
  const { storage, after } = gated();
  const outbox = createOutbox({ store: await new DataStore({ state: emptyState() }).init(), storage });
  const key = 'outbox/77777777-7777-4777-8777-777777777777/1';
  await storage.put(key, Buffer.from('orphan'), { contentType: 'text/plain' });
  after(() => storage.put(key, Buffer.from('put again'), { contentType: 'text/plain' }));
  assert.deepEqual(await outbox.sweep(), { deleted: 0, pending: 0 });
  assert.equal(await bytes(storage, key), 'put again');
  // Unchanged since listing: the next sweep reclaims it.
  assert.deepEqual(await outbox.sweep(), { deleted: 1, pending: 0 });
  assert.equal(await bytes(storage, key), null);
});

test('a sweep inside an open caller transaction keeps the bytes of its nested capture', async () => {
  const { storage } = gated();
  const store = await new DataStore({ state: emptyState() }).init();
  const outbox = createOutbox({ store, storage });
  let key, result;
  await store.transact(async () => {
    key = (await outbox.capture(message('Nested'), { nested: true })).attachments[0].key;
    result = await outbox.sweep();
  });
  assert.deepEqual(result, { deleted: 0, pending: 0 });
  assert.equal(await bytes(storage, key), 'invented attachment');
});
