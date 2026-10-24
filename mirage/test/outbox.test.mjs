import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { createOutbox, outboxDescriptor, waitForOutbox, OUTBOX_TABLE } from '../lib/outbox.mjs';

function fixedClock(start = Date.parse('2026-01-01T00:00:00Z')) { let t = start; return { now: () => t, advance: (ms) => (t += ms) }; }
function memoryStorage() {
  const objects = new Map(), deleted = [];
  return {
    objects, deleted,
    async put(key, body, { contentType } = {}) { objects.set(key, { body: Buffer.from(body), contentType }); return { key, size: body.length }; },
    async delete(key) { deleted.push(key); return objects.delete(key); },
    // Pages one key at a time in the shape storage-local-disk list returns: { items, continuation }.
    async list(prefix = '', { continuation = 0 } = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
      return { items: keys.slice(continuation, continuation + 1).map((key) => ({ key })), continuation: continuation + 1 < keys.length ? continuation + 1 : null };
    },
  };
}
const mail = (extra = {}) => ({ channel: 'email', from: 'noreply@fx.example.test', to: ['alex@fx.example.test'], subject: 'Invented', body: 'Hello', ...extra });

test('captured entries are listed and filtered by correlation, channel and time', async () => {
  const store = new DataStore(), clock = fixedClock();
  const outbox = createOutbox({ store, clock });
  const first = await outbox.capture(mail({ correlationId: 'corr-1', source: { kind: 'SendEmail', id: 'x-1' } }));
  clock.advance(1000);
  await outbox.capture(mail({ channel: 'teams', correlationId: 'corr-2' }));
  assert.equal(first.state, 'queued');
  assert.deepEqual(first.source, { kind: 'SendEmail', id: 'x-1' });
  assert.equal(outbox.list().length, 2);
  assert.deepEqual(outbox.list({ correlationId: 'corr-1' }).map((entry) => entry.id), [first.id]);
  assert.deepEqual(outbox.list({ channel: 'teams' }).map((entry) => entry.correlationId), ['corr-2']);
  assert.equal(outbox.list({ since: '2026-01-01T00:00:01Z' }).length, 1);
  assert.equal(outbox.get(first.id).subject, 'Invented');
  assert.equal(outbox.get('missing'), null);
  assert.equal(store.snapshot().mappings[OUTBOX_TABLE].entitySet, undefined);
  await assert.rejects(outbox.capture(mail({ channel: 'fax' })), /channel/);
});

test('entries move from queued to delivered or failed once', async () => {
  const outbox = createOutbox({ store: new DataStore(), clock: fixedClock() });
  const a = await outbox.capture(mail()), b = await outbox.capture(mail());
  assert.equal((await outbox.markDelivered(a.id)).state, 'delivered');
  const failed = await outbox.markFailed(b.id, 'invented bounce');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.failureReason, 'invented bounce');
  await assert.rejects(outbox.markDelivered(b.id), (error) => error.code === 'InvalidStateTransition');
  await assert.rejects(outbox.markFailed('missing'), (error) => error.status === 404);
});

test('retention keeps the newest entries and drops stored bytes of evicted ones', async () => {
  const storage = memoryStorage();
  const outbox = createOutbox({ store: new DataStore(), clock: fixedClock(), storage, retention: 3 });
  const first = await outbox.capture(mail({ subject: 's0', attachments: [{ name: 'a.txt', content: Buffer.from('x') }] }));
  for (const n of [1, 2, 3, 4]) await outbox.capture(mail({ subject: `s${n}` }));
  assert.deepEqual(outbox.list().map((entry) => entry.subject), ['s2', 's3', 's4']);
  assert.equal(outbox.get(first.id), null);
  assert.equal(storage.objects.size, 0);
});

test('without storage an attachment keeps metadata only and records a diagnostic', async () => {
  const outbox = createOutbox({ store: new DataStore(), clock: fixedClock() });
  const entry = await outbox.capture(mail({ attachments: [{ name: 'report.pdf', contentType: 'application/pdf', content: Buffer.from('invented bytes') }] }));
  assert.deepEqual(entry.attachments, [{ name: 'report.pdf', contentType: 'application/pdf', size: 14, key: null }]);
  assert.equal(entry.diagnostics[0].code, 'OUTBOX_ATTACHMENT_NOT_STORED');
});

test('with storage the bytes are stored under a key and the entry carries the key, not the bytes', async () => {
  const storage = memoryStorage(), store = new DataStore();
  const outbox = createOutbox({ store, clock: fixedClock(), storage });
  const entry = await outbox.capture(mail({ attachments: [{ name: 'note.txt', contentType: 'text/plain', content: Buffer.from('invented bytes').toString('base64') }] }));
  const [attachment] = entry.attachments;
  assert.match(attachment.key, /^outbox\//);
  assert.equal(storage.objects.get(attachment.key).body.toString(), 'invented bytes');
  assert.equal(entry.diagnostics.length, 0);
  assert.doesNotMatch(JSON.stringify(store.snapshot().tables[OUTBOX_TABLE]), /invented bytes|aW52ZW50ZWQgYnl0ZXM/);
});

test('a nested capture rolls back with its caller, and a failed capture write removes its stored bytes', async () => {
  const storage = memoryStorage(), store = new DataStore();
  const outbox = createOutbox({ store, clock: fixedClock(), storage });
  await assert.rejects(store.transact(async () => {
    await outbox.capture(mail({ attachments: [{ name: 'a', content: Buffer.from('x') }] }), { nested: true });
    throw new Error('invented rollback');
  }, { incremental: true }), /invented rollback/);
  assert.equal(outbox.list().length, 0);
  const failing = createOutbox({ store: { transact: async () => { throw new Error('invented write failure'); }, state: { tables: {}, mappings: {} } }, storage });
  storage.objects.clear();
  await assert.rejects(failing.capture(mail({ attachments: [{ name: 'a', content: Buffer.from('x') }] })), /invented write failure/);
  assert.equal(storage.objects.size, 0);
});

test('waitForOutbox resolves on a matching capture and times out otherwise', async () => {
  const outbox = createOutbox({ store: new DataStore() });
  setTimeout(() => outbox.capture(mail({ correlationId: 'late' })), 30);
  const entry = await waitForOutbox(outbox, (item) => item.correlationId === 'late', { timeoutMs: 2000 });
  assert.equal(entry.correlationId, 'late');
  const clock = fixedClock();
  const waiting = waitForOutbox(outbox, () => false, { timeoutMs: 60_000, clock });
  clock.advance(60_000);
  await assert.rejects(waiting, (error) => error.code === 'OutboxTimeout');
});

test('the outbox descriptor is a capture-only behaviour record', () => {
  assert.equal(outboxDescriptor.name, 'outbox:local');
  assert.equal(outboxDescriptor.level, 'behaviour');
  assert.equal(outboxDescriptor.fidelity, 'capture-only');
  assert.match(outboxDescriptor.notes.join(' '), /No network egress ever/);
});

test('a rolled-back nested capture keeps the evicted entry and its bytes, and defers nothing', async () => {
  const storage = memoryStorage(), store = new DataStore();
  const outbox = createOutbox({ store, clock: fixedClock(), storage, retention: 1 });
  const first = await outbox.capture(mail({ subject: 'A', attachments: [{ name: 'a.txt', content: Buffer.from('a') }] }));
  const firstKey = first.attachments[0].key;
  await assert.rejects(store.transact(async () => {
    await outbox.capture(mail({ subject: 'B', attachments: [{ name: 'b.txt', content: Buffer.from('b') }] }), { nested: true });
    throw new Error('invented rollback');
  }, { incremental: true }), /invented rollback/);
  assert.deepEqual(outbox.list().map((entry) => entry.id), [first.id]);
  assert.ok(storage.objects.has(firstKey));
  assert.deepEqual(storage.deleted, []);
  assert.deepEqual(store.state.simulator?.outboxPendingDeletes ?? [], []);
  await outbox.capture(mail({ subject: 'C' }));
  assert.deepEqual(outbox.list().map((entry) => entry.subject), ['C']);
  assert.equal(storage.objects.has(firstKey), false);
  assert.deepEqual(storage.deleted, [firstKey]);
});

test('a committed nested capture defers its evicted bytes until sweep runs', async () => {
  const storage = memoryStorage(), store = new DataStore();
  const outbox = createOutbox({ store, clock: fixedClock(), storage, retention: 1 });
  const first = await outbox.capture(mail({ subject: 'A', attachments: [{ name: 'a.txt', content: Buffer.from('a') }] }));
  const firstKey = first.attachments[0].key;
  await store.transact(() => outbox.capture(mail({ subject: 'B' }), { nested: true }), { incremental: true });
  assert.deepEqual(storage.deleted, []);
  assert.equal(store.state.simulator.outboxPendingDeletes.length, 1);
  assert.deepEqual(await outbox.sweep(), { deleted: 0, pending: 1 });
  assert.deepEqual(storage.deleted, [firstKey]);
  assert.equal(storage.objects.has(firstKey), false);
});

test('sweep reclaims the bytes of a rolled-back capture and keeps bytes that a live entry references', async () => {
  const storage = memoryStorage(), store = new DataStore();
  const outbox = createOutbox({ store, clock: fixedClock(), storage });
  const live = await outbox.capture(mail({ subject: 'live', attachments: [{ name: 'l.txt', content: Buffer.from('l') }] }));
  const liveKey = live.attachments[0].key;
  await assert.rejects(store.transact(async () => {
    await outbox.capture(mail({ subject: 'orphan', attachments: [{ name: 'o.txt', content: Buffer.from('o') }] }), { nested: true });
    throw new Error('invented rollback');
  }, { incremental: true }), /invented rollback/);
  const orphanKey = [...storage.objects.keys()].find((key) => key !== liveKey);
  assert.ok(orphanKey);
  assert.deepEqual(await outbox.sweep(), { deleted: 1, pending: 0 });
  assert.equal(storage.objects.has(orphanKey), false);
  assert.ok(storage.objects.has(liveKey));
  assert.deepEqual(await outbox.sweep(), { deleted: 0, pending: 0 });
});

test('sweep leaves the bytes of a capture whose row is still being written', async () => {
  const storage = memoryStorage();
  const outbox = createOutbox({ store: new DataStore(), clock: fixedClock(), storage });
  const put = storage.put.bind(storage);
  let putDone, release;
  const stored = new Promise((resolve) => { putDone = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  storage.put = async (...args) => { const result = await put(...args); putDone(); await gate; return result; };
  const capturing = outbox.capture(mail({ attachments: [{ name: 'f.txt', content: Buffer.from('f') }] }));
  await stored;
  assert.deepEqual(await outbox.sweep(), { deleted: 0, pending: 0 });
  assert.equal(storage.objects.size, 1);
  release();
  const entry = await capturing;
  assert.ok(storage.objects.has(entry.attachments[0].key));
});
